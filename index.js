const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
let solanaWeb3;
try {
  solanaWeb3 = require("@solana/web3.js");
} catch (error) {
  console.error("Failed to load @solana/web3.js:", error.message);
  throw new Error("Missing @solana/web3.js dependency");
}
const { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = solanaWeb3;
const bs58 = require("bs58");

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

// Solana setup
const connection = new solanaWeb3.Connection("https://rpc.gorbagana.wtf", {
  commitment: "finalized",
  disableRetryOnRateLimit: false,
});
const SERVER_WALLET = new PublicKey("BTwMeqRYsnME4jpLFWgCePmBQzPYpciCb19o4gw1BaHG");
const COINGECKO_TOKEN_ID = "gorbagana";
const PRICE_PRECISION = 5;
const ROUND_DURATION = 300;
const MAX_RETRIES = 1;
const TRANSACTION_RETRIES = 1;

// Load private key from Firebase Functions config
const config = functions.config();
console.log("Firebase Functions config:", JSON.stringify(config));
if (!config.solana || !config.solana.private_key) {
  console.error("solana.private_key not found in Firebase Functions config");
  throw new Error("solana.private_key is required");
}
const privateKey = config.solana.private_key;

// Debug bs58 module
console.log("bs58 module:", bs58, "typeof bs58.decode:", typeof bs58.decode);

// Use bs58.default.decode if bs58.decode is not a function
const bs58Decode = bs58.decode || (bs58.default && bs58.default.decode);
if (!bs58Decode) {
  console.error("bs58.decode function not found");
  throw new Error("bs58.decode is not available");
}

let keypair;
try {
  keypair = Keypair.fromSecretKey(bs58Decode(privateKey));
  console.log("Keypair created successfully, public key:", keypair.publicKey.toString());
} catch (error) {
  console.error("Invalid solana.private_key:", error.message);
  throw new Error("Failed to decode solana.private_key: " + error.message);
}

// Fetch token price from CoinGecko
async function fetchSolPrice() {
  console.log(`Fetching price for token ID ${COINGECKO_TOKEN_ID} from CoinGecko`);
  try {
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_TOKEN_ID}&vs_currencies=usd`
    );
    const tokenPrice = Number(response.data[COINGECKO_TOKEN_ID].usd.toFixed(PRICE_PRECISION));
    if (tokenPrice <= 0) {
      throw new Error("Invalid price received from CoinGecko");
    }
    console.log("CoinGecko price fetched:", tokenPrice);
    return tokenPrice;
  } catch (error) {
    console.error("CoinGecko fetch failed:", error);
    throw new Error(`Failed to fetch ${COINGECKO_TOKEN_ID} price: ${error.message}`);
  }
}

// Distribute profits for a round
// Distribute profits for a round
async function distributeProfits(round) {
  if (round.endPrice == null || round.distributed) {
    console.log("Skipping distribution:", {
      noEndPrice: round.endPrice == null,
      alreadyDistributed: round.distributed,
    });
    return;
  }

  console.log(`Distributing profits for round ${round.id}`);
  try {
    const betsRef = db.collection("rounds").doc(round.id).collection("bets");
    const betsSnapshot = await betsRef.get();
    const bets = betsSnapshot.docs.map((doc) => doc.data());
    console.log("Bets fetched for round", round.id, ":", bets.length);

    const totalBetsAmount = bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
    if (Math.abs(round.totalPool - totalBetsAmount) > 0.000001) {
      throw new Error(`totalPool mismatch: Firestore=${round.totalPool}, Calculated=${totalBetsAmount}`);
    }

    const isDraw = round.startPrice === round.endPrice;
    const isUp = round.endPrice > round.startPrice;
    console.log("Round outcome:", isDraw ? "Draw" : isUp ? "Up" : "Down");

    const upBets = bets.filter((bet) => bet.prediction);
    const downBets = bets.filter((bet) => !bet.prediction);
    const totalUpAmount = upBets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
    const totalDownAmount = downBets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
    const matchedAmount = Math.min(totalUpAmount, totalDownAmount);
    const feePercentage = 0.025; // 2.5% fee
    const feeAmount = matchedAmount * feePercentage;
    const payoutPool = matchedAmount * (1 - feePercentage); // Matched amount after fee for winners

    // Estimate transaction fees
    const sampleInstruction = SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: keypair.publicKey,
      lamports: 0,
    });
    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash("finalized")).blockhash,
      instructions: [sampleInstruction],
    }).compileToV0Message();
    const feeEstimate = await connection.getFeeForMessage(messageV0, "finalized");
    if (feeEstimate.value == null) {
      throw new Error("Failed to estimate transaction fee");
    }
    const uniqueWallets = [...new Set(bets.map((bet) => bet.walletAddress))];
    const totalFeeLamports = uniqueWallets.length * feeEstimate.value;

    // Calculate required SOL
    const requiredSol = totalBetsAmount + totalFeeLamports / 1e9; // Total bets (refunds + payouts) + fees
    const balance = await connection.getBalance(keypair.publicKey);
    if (balance / 1e9 < requiredSol) {
      throw new Error(`Insufficient balance: ${balance / 1e9} $GOR available, ${requiredSol} $GOR required`);
    }

    await db.runTransaction(async (transaction) => {
      const roundRef = db.collection("rounds").doc(round.id);
      const roundDoc = await transaction.get(roundRef);
      if (!roundDoc.exists || roundDoc.data().distributed) {
        console.log("Round already distributed or does not exist");
        return;
      }

      const BLOCKHASH_VALIDITY_BUFFER = 10;
      const MAX_BLOCKHASH_AGE_MS = 30000;

      // Calculate payouts and refunds
      const walletPayments = {};

      if (isDraw || bets.length === 0 || (bets.length > 0 && bets.every((bet) => bet.prediction === bets[0].prediction))) {
        // Refund all bets for draw or uniform predictions
        bets.forEach((bet) => {
          walletPayments[bet.walletAddress] = (walletPayments[bet.walletAddress] || 0) + bet.amount;
        });
        console.log("Processing", isDraw ? "draw refund" : "uniform bets refund", "Payments:", walletPayments);
      } else {
        // Determine winners and losers
        const winningBets = isUp ? upBets : downBets;
        const losingBets = isUp ? downBets : upBets;
        const totalWinningAmount = winningBets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
        const totalLosingAmount = losingBets.reduce((sum, bet) => sum + (bet.amount || 0), 0);

        // Winners: Refund original bet + share of payoutPool
        if (totalWinningAmount > 0 && matchedAmount > 0) {
          winningBets.forEach((bet) => {
            const proportion = bet.amount / totalWinningAmount;
            const profit = proportion * payoutPool;
            // Refund original bet + profit
            walletPayments[bet.walletAddress] = (walletPayments[bet.walletAddress] || 0) + bet.amount + profit;
          });
        }

        // Losers: Refund unmatched portion
        if (totalLosingAmount > matchedAmount) {
          const unmatchedProportion = 1 - matchedAmount / totalLosingAmount;
          losingBets.forEach((bet) => {
            const refund = bet.amount * unmatchedProportion;
            if (refund > 0) {
              walletPayments[bet.walletAddress] = (walletPayments[bet.walletAddress] || 0) + refund;
            }
          });
        }

        console.log("Payments (payouts + refunds):", walletPayments);
      }

      // Process all transactions
      for (const [walletAddress, totalAmount] of Object.entries(walletPayments)) {
        if (totalAmount <= 0) continue;

        console.log(`Paying ${totalAmount} $GOR to ${walletAddress}`);
        let signature;
        let attempts = 0;
        while (attempts < TRANSACTION_RETRIES) {
          attempts++;
          console.log(`Payout attempt ${attempts} of ${TRANSACTION_RETRIES} for ${walletAddress}`);
          try {
            const blockhashFetchTime = Date.now();
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
            console.log(`Attempt ${attempts}: Blockhash fetched: ${blockhash}, Last valid block height: ${lastValidBlockHeight}`);

            const currentBlockHeight = await connection.getBlockHeight("finalized");
            if (currentBlockHeight >= lastValidBlockHeight - BLOCKHASH_VALIDITY_BUFFER) {
              console.warn("Blockhash is too old, retrying...");
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }

            if (Date.now() - blockhashFetchTime > MAX_BLOCKHASH_AGE_MS) {
              console.warn("Blockhash fetch took too long, retrying...");
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }

            const instruction = SystemProgram.transfer({
              fromPubkey: keypair.publicKey,
              toPubkey: new PublicKey(walletAddress),
              lamports: Math.floor(totalAmount * 1e9),
            });

            const messageV0 = new TransactionMessage({
              payerKey: keypair.publicKey,
              recentBlockhash: blockhash,
              instructions: [instruction],
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([keypair]);

            const signTime = Date.now();
            if (Date.now() - blockhashFetchTime > MAX_BLOCKHASH_AGE_MS) {
              console.warn("Transaction signing took too long, retrying...");
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }
            console.log(`Transaction signed in ${Date.now() - signTime}ms`);

            const sendStartTime = Date.now();
            signature = await connection.sendTransaction(transaction, {
              skipPreflight: false,
              maxRetries: 3,
            });
            console.log(`Transaction sent to ${walletAddress}: ${signature}, Time: ${Date.now() - sendStartTime}ms`);

            let confirmationAttempts = 0;
            const maxConfirmationAttempts = 30;
            while (confirmationAttempts < maxConfirmationAttempts) {
              const status = await connection.getSignatureStatus(signature);
              if (status.value?.confirmationStatus === "finalized") {
                console.log(`Transaction finalized for ${walletAddress}: ${signature}`);
                break;
              }
              if (status.value?.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
              }
              console.log(
                `Confirmation attempt ${confirmationAttempts + 1}, status: ${status.value?.confirmationStatus || "pending"}`
              );
              await new Promise((resolve) => setTimeout(resolve, 1000));
              confirmationAttempts++;
            }

            if (confirmationAttempts >= maxConfirmationAttempts) {
              throw new Error(`Transaction confirmation timed out for ${walletAddress}: ${signature}`);
            }

            console.log(`Payout sent to ${walletAddress}: ${signature}`);
            break;
          } catch (error) {
            console.error(`Payout attempt ${attempts} failed for ${walletAddress}:`, error.message);
            if (
              error.message.includes("Blockhash not found") ||
              error.message.includes("block height exceeded") ||
              error.message.includes("Transaction expired") ||
              error.message.includes("429") ||
              error.message.includes("rate limit")
            ) {
              console.log("Retrying due to transient error...");
              await new Promise((resolve) => setTimeout(resolve, error.message.includes("429") ? 5000 : 2000));
              continue;
            }
            if (attempts >= TRANSACTION_RETRIES) {
              throw new Error(`Payout failed for ${walletAddress}: ${error.message}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
        if (!signature) {
          throw new Error(`Failed to send payout to ${walletAddress} after ${TRANSACTION_RETRIES} retries`);
        }
      }

      transaction.update(roundRef, {
        draw: isDraw,
        distributed: true,
        distributionTime: new Date().toISOString(),
        refundedUniform: bets.length > 0 && bets.every((bet) => bet.prediction === bets[0].prediction) && !isDraw,
      });
      console.log("Distribution completed for round", round.id);
    });
    console.log(`Profits distributed for round ${round.id}`);
  } catch (error) {
    console.error("Profit distribution failed for round", round.id, ":", error.message, error.stack);
    throw error;
  }
}

// Finalize round and start a new one
async function finalizeAndStartNewRound(currentRound) {
  console.log(`Finalizing round ${currentRound.id}`);
  try {
    await db.runTransaction(async (transaction) => {
      const roundRef = db.collection("rounds").doc(currentRound.id);
      const roundDoc = await transaction.get(roundRef);

if (!roundDoc.exists) {
        throw new Error(`Round ${currentRound.id} does not exist`);
      }
      if (roundDoc.data().endPrice != null) {
        console.log(`Round ${currentRound.roundId} already finalized`);
        return;
      }

      const endPrice = await fetchSolPrice();
      transaction.update(roundRef, {
        endPrice,
        endTime: new Date().toISOString(),
      });

      // Only start a new round if all finalized rounds are distributed
      const roundsSnapshot = await db.collection("rounds").get();
      const finalizedRounds = roundsSnapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((round) => round.endPrice != null && !round.distributed);
      if (finalizedRounds.length > 0) {
        console.log("Cannot start new round: undistributed finalized rounds exist", finalizedRounds);
        return;
      }

      const newRoundId = currentRound.roundId + 1;
      const newRound = {
        id: newRoundId.toString(),
        roundId: newRoundId,
        startPrice: endPrice,
        endPrice: null,
        startTime: new Date().toISOString(),
        totalPool: 0,
        distributed: false,
      };
      const newRoundRef = db.collection("rounds").doc(newRoundId.toString());
      transaction.set(newRoundRef, newRound);
      console.log("Started new round:", newRound);
    });
    console.log(`Round ${currentRound.id} finalized`);
  } catch (error) {
    console.error("Error finalizing round:", error);
    throw error;
  }
}

// Scheduled function to manage rounds every 2 minutes
exports.manageBettingRounds = functions
  .runWith({ timeoutSeconds: 120, memory: "1GB" })
  .pubsub.schedule("every 2 minutes")
  .onRun(async () => {
    console.log("Starting manageBettingRounds execution");
    try {
      // Fetch all rounds
      const roundsSnapshot = await db.collection("rounds").get();
      const rounds = roundsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      // Validate rounds
      const validRounds = rounds.filter((round) => {
        const isValid =
          round.id &&
          typeof round.roundId === "number" &&
          typeof round.startPrice === "number" &&
          (typeof round.startTime === "string" || round.startTime instanceof admin.firestore.Timestamp) &&
          typeof round.totalPool === "number" &&
          typeof round.distributed === "boolean";
        if (!isValid) {
          console.warn(`Invalid round detected: ${round.id}`, round);
        }
        return isValid;
      });

      // Find current round (not finalized)
      const currentRound = validRounds
        .filter((round) => round.endPrice == null)
        .sort((a, b) => b.roundId - a.roundId)[0];
      console.log("Current round:", currentRound);

      // Initialize first round if none exist
      if (!currentRound && validRounds.length === 0) {
        console.log("No valid rounds found, initializing first round");
        const solPrice = await fetchSolPrice();
        const newRound = {
          id: "1",
          roundId: 1,
          startPrice: solPrice,
          endPrice: null,
          startTime: new Date().toISOString(),
          totalPool: 0,
          distributed: false,
        };
        await db.collection("rounds").doc("1").set(newRound);
        console.log("Initialized first round:", newRound);
        return;
      }

      // Distribute profits for finalized but undistributed rounds, oldest first
      const finalizedRounds = validRounds
        .filter((round) => round.endPrice != null && !round.distributed)
        .sort((a, b) => a.roundId - b.roundId);
      for (const round of finalizedRounds) {
        await distributeProfits(round);
      }

      // Only finalize the current round if all finalized rounds are distributed
      if (currentRound) {
        const startTime = typeof currentRound.startTime === "string"
          ? new Date(currentRound.startTime)
          : currentRound.startTime.toDate();
        if (isNaN(startTime.getTime())) {
          console.error("Invalid startTime for round:", currentRound.id, currentRound.startTime);
          return;
        }
        const now = new Date();
        const elapsedSeconds = Math.floor((now.getTime() - startTime.getTime()) / 1000);

        if (elapsedSeconds >= ROUND_DURATION && finalizedRounds.length === 0) {
          await finalizeAndStartNewRound(currentRound);
        } else if (finalizedRounds.length > 0) {
          console.log("Skipping finalization due to undistributed rounds:", finalizedRounds);
        } else {
          console.log("Current round not ready for finalization:", { roundId: currentRound.roundId, elapsedSeconds });
        }
      } else {
        console.log("No current round found, but rounds exist");
        // Check if the latest finalized round is distributed
        const latestFinalizedRound = validRounds
          .filter((round) => round.endPrice != null)
          .sort((a, b) => b.roundId - a.roundId)[0];
        if (latestFinalizedRound && !latestFinalizedRound.distributed) {
          console.log("Latest finalized round not distributed, cannot start new round:", latestFinalizedRound);
        } else {
          console.log("Starting new round as all finalized rounds are distributed");
          const solPrice = await fetchSolPrice();
          const newRoundId = (latestFinalizedRound ? latestFinalizedRound.roundId + 1 : 1).toString();
          const newRound = {
            id: newRoundId,
            roundId: parseInt(newRoundId),
            startPrice: solPrice,
            endPrice: null,
            startTime: new Date().toISOString(),
            totalPool: 0,
            distributed: false,
          };
          await db.collection("rounds").doc(newRoundId).set(newRound);
          console.log("Initialized new round:", newRound);
        }
      }

      console.log("manageBettingRounds execution completed");
    } catch (error) {
      console.error("Error in manageBettingRounds:", error);
      throw error;
    }
  });
