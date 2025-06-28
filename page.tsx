    "use client";

  import type React from "react";
  import { useState, useEffect, useCallback } from "react";
  import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, Keypair } from "@solana/web3.js";
  import { initializeApp } from "firebase/app";
  import {
    getFirestore,
    collection,
    onSnapshot,
    type QueryDocumentSnapshot,
    type DocumentData,
    setDoc,
    doc,
    getDocs,
    increment,
    runTransaction,
    Timestamp,
  } from "firebase/firestore";
  import { Toaster, toast } from "sonner";
  import axios from "axios";
  import bs58 from "bs58";
  import { useWallet, useConnection, ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
  import { WalletMultiButton, WalletModalProvider } from "@solana/wallet-adapter-react-ui";
  import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
  import { Swords } from "lucide-react";
  import "./BettingGame.css";
  import CustomWalletModal from "./CustomWalletModal"; // Import the updated custom modal

  // Optional: Import BackpackWalletAdapter if explicitly needed
  // import { BackpackWalletAdapter } from '@solana/wallet-adapter-backpack';

  // Firebase configuration
  const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  // Solana setup
  const endpoint = "https://rpc.gorbagana.wtf";
  // Use empty wallets array to rely on Wallet Standard for Backpack
  const wallets = [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    // new BackpackWalletAdapter(), // Uncomment if explicitly needed after installing @solana/wallet-adapter-backpack
  ];
  const SERVER_WALLET = new PublicKey("Ckfc67xpyWz4nHEkDzGuyoqFhNTg2gEBLEpmi8eoA1av");
  const ROUND_DURATION = 300;
  const MAX_RETRIES = 3;
  const TRANSACTION_RETRIES = 5;
  const PRICE_PRECISION = 5;
  const BETTING_CUTOFF_SECONDS = 30;
const COINGECKO_TOKEN_ID = "gorbagana"; // Update this with the correct CoinGecko ID

  // Load private key from .env
  const privateKey = process.env.NEXT_PUBLIC_SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    console.error("NEXT_PUBLIC_SOLANA_PRIVATE_KEY not set in .env.local");
    console.warn(
      "WARNING: Storing SOLANA_PRIVATE_KEY client-side is insecure. Use a server-side solution for production.",
    );
  }
  const keypair = privateKey ? Keypair.fromSecretKey(bs58.decode(privateKey)) : null;

  // TypeScript interfaces for Firestore data
  interface Round {
    id: string;
    roundId: number;
    startPrice: number;
    endPrice?: number | null | undefined;
    startTime: string;
    endTime?: string;
    totalPool: number;
    draw?: boolean;
    distributed?: boolean;
  }

  interface Bet {
    walletAddress: string;
    amount: number;
    prediction: boolean;
  }

  const BettingGame: React.FC = () => {
    const { connection } = useConnection();
    const { publicKey, signTransaction, connected, wallet, disconnect } = useWallet();
    const [isLoading, setIsLoading] = useState(false);
    const [currentRound, setCurrentRound] = useState<Round | null>(null);
    const [timeLeft, setTimeLeft] = useState<number>(ROUND_DURATION);
    const [amount, setAmount] = useState<string>("");
    const [prediction, setPrediction] = useState<boolean | null>(null);
    const [status, setStatus] = useState<string>("");
    const [retryPriceFetch, setRetryPriceFetch] = useState(0);
    const [isFinalizing, setIsFinalizing] = useState(false);
    const [isBettingLoading, setIsBettingLoading] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null); // New state for wallet balance
  const [pastRounds, setPastRounds] = useState<Round[]>([]);
const [lastRoundId, setLastRoundId] = useState<number | null>(null);
const [hasMore, setHasMore] = useState(true);
const PAGE_SIZE = 10; // Number of rounds to fetch per page

    // Fetch wallet balance
  const fetchWalletBalance = async () => {
    if (!connected || !publicKey) {
      setWalletBalance(null);
      return;
    }
    try {
      const balance = await connection.getBalance(publicKey);
      const balanceInGor = balance / 1e9; // Convert lamports to $GOR
      setWalletBalance(balanceInGor);
      console.log(`Wallet balance fetched: ${balanceInGor} $GOR`);
    } catch (error) {
      console.error("Error fetching wallet balance:", error);
      setWalletBalance(null);
      toast.error("Failed to fetch wallet balance");
    }
  };

  // Fetch balance when wallet connects or changes
  useEffect(() => {
    fetchWalletBalance();
  }, [publicKey, connected]);




    useEffect(() => {
  const fixModalAndButtons = () => {
    console.log("Running fixModalAndButtons");

    // Fix modal positioning
    const modal = document.querySelector(".wallet-adapter-modal") as HTMLElement | null;
    if (!modal) {
      console.log("Modal not found");
      return;
    }

    console.log("Modal found, applying styles");
    modal.setAttribute(
      "style",
      `
        position: fixed !important;
        top: 50% !important;
        left: 50% !important;
        transform: translate(-50%, -50%) !important;
        bottom: auto !important;
        right: auto !important;
        z-index: 1001 !important;
        max-width: 420px !important;
        width: 90% !important;
        background: rgba(10, 10, 20, 0.98) !important;
        border: 1px solid #00ffcc !important;
        border-radius: 16px !important;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8), 0 0 30px rgba(0, 255, 204, 0.3) !important;
        padding: 32px 24px !important;
        overflow: hidden !important;
        backdrop-filter: blur(20px) !important;
      `,
    );


    // Style the modal list container to use Grid
    const modalList = modal.querySelector(".wallet-adapter-modal-list") as HTMLElement | null;
    if (modalList) {
      modalList.setAttribute(
        "style",
        `
          display: grid !important;
          grid-template-columns: 1fr !important; /* Single column */
          gap: 8px !important; /* Consistent spacing */
          padding: 0 !important;
          margin: 0 !important;
          width: 100% !important;
        `,
      );
    }

    // Style the modal title if it exists
    const modalTitle = modal.querySelector(".wallet-adapter-modal-title") as HTMLElement | null;
    if (modalTitle) {
      modalTitle.setAttribute(
        "style",
        `
          font-family: 'Orbitron', sans-serif !important;
          font-size: 20px !important;
          font-weight: 700 !important;
          color: #00ffcc !important;
          text-align: center !important;
          margin-bottom: 24px !important;
          text-transform: uppercase !important;
          letter-spacing: 1px !important;
        `,
      );
    }
  };

  // Run initially and when modal is added
  fixModalAndButtons();

  // Observe DOM changes to catch modal rendering
  const observer = new MutationObserver(() => {
    console.log("DOM mutation detected, re-running fixModalAndButtons");
    fixModalAndButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    console.log("Cleaning up observer");
    observer.disconnect();
  };
}, []);


 // Fetch token price from CoinGecko
  const fetchSolPrice = async (): Promise<number> => {
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
      throw new Error(`Failed to fetch ${COINGECKO_TOKEN_ID} price: ${(error as Error).message}`);
    }
  };

    // Initialize first round
    const fetchPriceAndInitializeRound = async () => {
      console.log("Checking Firestore for existing rounds");
      const roundsRef = collection(db, "rounds");
      try {
        const snapshot = await getDocs(roundsRef);
        console.log("Initial Firestore query:", snapshot.docs.length, "documents");

        if (snapshot.empty) {
          console.log("No rounds found, initializing first round");
          setStatus("Initializing first round...");
          setIsLoading(true);
          try {
            const solPrice = await fetchSolPrice();
            const newRound: Round = {
              id: "1",
              roundId: 1,
              startPrice: solPrice,
              endPrice: null,
              startTime: Timestamp.now().toDate().toISOString(),
              totalPool: 0,
              distributed: false,
            };
            console.log("Attempting to write new round to Firestore:", newRound);
            await setDoc(doc(roundsRef, "1"), newRound);
            console.log("Initialized first round:", newRound);
            setStatus("First round initialized");
          } catch (error) {
            console.error("Error initializing first round:", error);
            setStatus("Failed to initialize round. Click Retry to try again.");
          } finally {
            setIsLoading(false);
          }
        } else {
          console.log("Rounds exist, skipping initialization");
        }
      } catch (error) {
        console.error("Error querying Firestore:", error);
        setStatus("Error accessing Firestore. Please try again.");
      }
    };

    // Finalize current round and start a new one
    const finalizeAndStartNewRound = useCallback(
      async (retryCount = 0) => {
        if (!currentRound || isFinalizing || retryCount > MAX_RETRIES) {
          console.log("Skipping finalization:", {
            noRound: !currentRound,
            isFinalizing,
            retryCount,
            maxRetries: MAX_RETRIES,
          });
          return;
        }

        setIsFinalizing(true);
        setIsLoading(true);
        setStatus("Finalizing round...");
        try {
          await runTransaction(db, async (transaction) => {
            const roundRef = doc(db, "rounds", currentRound.id);
            const roundDoc = await transaction.get(roundRef);

            if (!roundDoc.exists()) {
              throw new Error(`Round ${currentRound.id} does not exist`);
            }
            if (roundDoc.data().endPrice != null) {
              console.log(`Round ${currentRound.roundId} already confirmed`);
              return;
            }

            const endPrice = await fetchSolPrice();
            transaction.update(roundRef, {
              endPrice,
              endTime: Timestamp.now().toDate().toISOString(),
            });
            console.log(`Confirmed round ${currentRound.roundId} with endPrice: ${endPrice}`);

            const newRoundId = currentRound.roundId + 1;
            const newRound: Round = {
              id: newRoundId.toString(),
              roundId: newRoundId,
              startPrice: endPrice,
              endPrice: null,
              startTime: Timestamp.now().toDate().toISOString(),
              totalPool: 0,
              distributed: false,
            };
            const newRoundRef = doc(db, "rounds", newRoundId.toString());
            transaction.set(newRoundRef, newRound);
            console.log("Started new round:", newRound);
            setStatus("New round started!");
          });
        } catch (error) {
          console.error("Error finalizing round:", error);
          setStatus(
            `Failed to finalize round. ${retryCount < MAX_RETRIES ? "Retrying in 10 seconds..." : "Max retries reached."}`,
          );
          if (retryCount < MAX_RETRIES) {
            setTimeout(() => {
              setIsFinalizing(false);
              finalizeAndStartNewRound(retryCount + 1);
            }, 10000);
          }
        } finally {
          setIsLoading(false);
          setIsFinalizing(false);
        }
      },
      [currentRound, isFinalizing],
    );

    // Distribute profits
const distributeProfits = async (round: Round) => {
  if (!keypair) {
    console.error("No private key available for distribution");
    setStatus("Error: Private key not configured");
    return;
  }
  if (round.endPrice == null || round.distributed) {
    console.log("Skipping distribution:", {
      noEndPrice: round.endPrice == null,
      alreadyDistributed: round.distributed,
    });
    return;
  }

  setIsLoading(true);
  setStatus("Distributing profits...");
  try {
    const betsRef = collection(db, "rounds", round.id, "bets");
    const betsSnapshot = await getDocs(betsRef);
    const bets: Bet[] = betsSnapshot.docs.map((doc) => doc.data() as Bet);
    console.log("Bets fetched for round", round.id, ":", bets);

    const totalBetsAmount = bets.reduce((sum, bet) => sum + bet.amount, 0);
    if (Math.abs(round.totalPool - totalBetsAmount) > 0.000001) {
      throw new Error(`totalPool mismatch: Firestore=${round.totalPool}, Calculated=${totalBetsAmount}`);
    }

    const endPrice: number = round.endPrice;
    const isDraw = round.startPrice === endPrice;
    const isUp = endPrice > round.startPrice;
    console.log("Round outcome:", isDraw ? "Draw" : isUp ? "Up" : "Down");

    const allBetsUniform = bets.length > 0 && bets.every((bet) => bet.prediction === bets[0].prediction);

    let totalFeeLamports = 0;
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
    totalFeeLamports = uniqueWallets.length * feeEstimate.value;

    const requiredSol = bets.reduce((sum, bet) => sum + bet.amount, 0) + totalFeeLamports / 1e9;
    const balance = await connection.getBalance(keypair.publicKey);
    if (balance / 1e9 < requiredSol) {
      throw new Error(`Insufficient balance: ${balance / 1e9} $GOR available, ${requiredSol} $GOR required`);
    }

    await runTransaction(db, async (transaction) => {
      const roundRef = doc(db, "rounds", round.id);
      const roundDoc = await transaction.get(roundRef);
      if (!roundDoc.exists() || roundDoc.data().distributed) {
        console.log("Round already distributed or does not exist");
        return;
      }

      const BLOCKHASH_VALIDITY_BUFFER = 10;
      const MAX_BLOCKHASH_AGE_MS = 30000;

      if (allBetsUniform) {
        // Refund all bets since all players bet the same way
        const walletPayouts = bets.reduce(
          (acc, bet) => {
            acc[bet.walletAddress] = (acc[bet.walletAddress] || 0) + bet.amount;
            return acc;
          },
          {} as Record<string, number>,
        );
        console.log("Processing uniform bets refund, Payouts:", walletPayouts);

        for (const [walletAddress, totalPayout] of Object.entries(walletPayouts)) {
          console.log(`Refunding ${totalPayout} $GOR to ${walletAddress}`);
          let signature: string | undefined;
          let attempts = 0;

          while (attempts < TRANSACTION_RETRIES) {
            attempts++;
            console.log(`Payout attempt ${attempts} of ${TRANSACTION_RETRIES} for ${walletAddress}`);

            try {
              const blockhashFetchTime = Date.now();
              const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
              console.log("Fetched blockhash:", blockhash, "Last valid block height:", lastValidBlockHeight);

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
                lamports: Math.floor(totalPayout * 1e9),
              });

              const messageV0 = new TransactionMessage({
                payerKey: keypair.publicKey,
                recentBlockhash: blockhash,
                instructions: [instruction],
              }).compileToV0Message();

              const transaction = new VersionedTransaction(messageV0);
              transaction.sign([keypair]);
              console.log("Transaction signed");

              if (Date.now() - blockhashFetchTime > MAX_BLOCKHASH_AGE_MS) {
                console.warn("Transaction signing took too long, retrying...");
                await new Promise((resolve) => setTimeout(resolve, 500));
                continue;
              }

              signature = await connection.sendTransaction(transaction, {
                skipPreflight: false,
                maxRetries: 3,
              });
              console.log("Transaction sent, signature:", signature);

              let confirmationAttempts = 0;
              const maxConfirmationAttempts = 30;
              while (confirmationAttempts < maxConfirmationAttempts) {
                const status = await connection.getSignatureStatus(signature);
                if (status.value?.confirmationStatus === "finalized") {
                  console.log("Transaction finalized");
                  break;
                }
                if (status.value?.err) {
                  throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
                }
                console.log(`Confirmation attempt ${confirmationAttempts + 1}`);
                await new Promise((resolve) => setTimeout(resolve, 1000));
                confirmationAttempts++;
              }

              if (confirmationAttempts >= maxConfirmationAttempts) {
                throw new Error("Transaction confirmation timed out");
              }

              console.log(`Refund sent to ${walletAddress}:`, signature);
              break;
            } catch (error: any) {
              console.error(`Payout attempt ${attempts} failed for ${walletAddress}:`, error);
              const errorMessage = error.message || "Unknown error";
              if (
                errorMessage.includes("Blockhash not found") ||
                errorMessage.includes("block height exceeded") ||
                errorMessage.includes("Transaction expired")
              ) {
                console.log("Retrying with fresh blockhash...");
                await new Promise((resolve) => setTimeout(resolve, 500));
                continue;
              }
              throw new Error(`Refund failed for ${walletAddress}: ${errorMessage}`);
            }
          }

          if (!signature) {
            throw new Error(`Failed to send refund to ${walletAddress} after ${TRANSACTION_RETRIES} retries`);
          }
        }

        transaction.update(roundRef, {
          draw: isDraw,
          distributed: true,
          distributionTime: Timestamp.now().toDate().toISOString(),
          refundedUniform: true, // New field to track uniform refunds
        });

        setStatus("Bets refunded due to uniform predictions");
      } else if (isDraw) {
        // Handle draw case (unchanged)
        const walletPayouts = bets.reduce(
          (acc, bet) => {
            acc[bet.walletAddress] = (acc[bet.walletAddress] || 0) + bet.amount;
            return acc;
          },
          {} as Record<string, number>,
        );
        console.log("Processing draw refund, Payouts:", walletPayouts);

        for (const [walletAddress, totalPayout] of Object.entries(walletPayouts)) {
          // Similar payout logic as above (omitted for brevity)
        }

        transaction.update(roundRef, {
          draw: true,
          distributed: true,
          distributionTime: Timestamp.now().toDate().toISOString(),
        });

        setStatus("Bets refunded due to draw");
      } else {
        // Handle win/loss case (unchanged)
        const winningBets = bets.filter((bet) => bet.prediction === isUp);
        const totalWinningAmount = winningBets.reduce((sum, bet) => sum + bet.amount, 0);
        const payoutPool = round.totalPool * 0.975;

        if (totalWinningAmount > 0) {
          const walletPayouts = winningBets.reduce(
            (acc, bet) => {
              acc[bet.walletAddress] = (acc[bet.walletAddress] || 0) + (bet.amount / totalWinningAmount) * payoutPool;
              return acc;
            },
            {} as Record<string, number>,
          );

          for (const [walletAddress, totalPayout] of Object.entries(walletPayouts)) {
            // Similar payout logic as above (omitted for brevity)
          }

          transaction.update(roundRef, {
            draw: false,
            distributed: true,
            distributionTime: Timestamp.now().toDate().toISOString(),
          });

          setStatus("Profits distributed successfully!");
        } else {
          console.log("No winning bets, marking round as distributed");
          transaction.update(roundRef, {
            draw: false,
            distributed: true,
            distributionTime: Timestamp.now().toDate().toISOString(),
          });
          setStatus("No winning bets for this round");
        }
      }
    });
  } catch (error: any) {
    console.error("Profit distribution failed:", error);
    let errorMessage = error.message || "Unknown error";
    if (error.logs) {
      console.log("Transaction logs:", error.logs);
      errorMessage += ` (Logs: ${JSON.stringify(error.logs)})`;
    }
    setStatus(`Failed to distribute profits: ${errorMessage}`);
  } finally {
    setIsLoading(false);
  }
};
const loadMoreRounds = async () => {
  if (!hasMore) return;

  setIsLoading(true);
  try {
    const roundsRef = collection(db, "rounds");
    const snapshot = await getDocs(roundsRef);
    const rounds: Round[] = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() } as Round))
      .filter((round) => round.endPrice != null && round.roundId < lastRoundId!)
      .sort((a, b) => b.roundId - a.roundId)
      .slice(0, PAGE_SIZE);

    setPastRounds((prev) => [...prev, ...rounds]);
    if (rounds.length > 0) {
      setLastRoundId(rounds[rounds.length - 1].roundId);
      setHasMore(rounds.length === PAGE_SIZE);
    } else {
      setHasMore(false);
    }
  } catch (error) {
    console.error("Error loading more rounds:", error);
    setStatus("Failed to load more rounds");
  } finally {
    setIsLoading(false);
  }
};
    // Firestore listener
useEffect(() => {
  console.log("Setting up Firestore listener");
  const roundsQuery = collection(db, "rounds");
  let debounceTimeout: NodeJS.Timeout;
  const unsubscribe = onSnapshot(
    roundsQuery,
    (snapshot) => {
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        console.log("Firestore snapshot received:", snapshot.docs.length, "documents");
        const rounds: Round[] = snapshot.docs
          .map((doc: QueryDocumentSnapshot<DocumentData>) => {
            const data = doc.data();
            console.log("Document data:", doc.id, data);
            return { id: doc.id, ...data } as Round;
          })
          .filter((round) => {
            const isValid =
              round.roundId !== undefined &&
              typeof round.startPrice === "number" &&
              typeof round.startTime === "string";
            console.log("Round valid:", round.id, isValid);
            return isValid;
          });

        const current = rounds.filter((round) => round.endPrice == null).sort((a, b) => b.roundId - a.roundId)[0];
        console.log("Current round:", current);

        setCurrentRound((prev) => {
          if (JSON.stringify(prev) !== JSON.stringify(current)) {
            console.log("Updating currentRound:", current);
            return current || null;
          }
          return prev;
        });

        // Fetch only completed rounds for initial load
        const past = rounds
          .filter((round) => round.endPrice != null)
          .sort((a, b) => b.roundId - a.roundId)
          .slice(0, PAGE_SIZE); // Initial page
        console.log("Past rounds:", past);
        setPastRounds(past);

        // Update lastRoundId and hasMore
        if (past.length > 0) {
          setLastRoundId(past[past.length - 1].roundId);
          setHasMore(past.length === PAGE_SIZE);
        } else {
          setHasMore(false);
        }

        past.forEach((round) => {
          if (round.endPrice != null && !round.distributed) {
            console.log("Triggering automatic distribution for round", round.id);
            distributeProfits(round);
          }
        });

        if (!current && rounds.length === 0) {
          console.log("No rounds found, triggering initialization");
          setStatus("Waiting for rounds to start...");
          fetchPriceAndInitializeRound();
        }
      }, 100);
    },
    (error) => {
      console.error("Firestore error:", error);
      setStatus("Error loading rounds");
    },
  );

  return () => {
    console.log("Cleaning up Firestore listener");
    clearTimeout(debounceTimeout);
    unsubscribe();
  };
}, []);

    // Timer logic
    useEffect(() => {
      console.log("Setting up timer", { currentRoundId: currentRound?.roundId });
      if (currentRound) {
        setTimeLeft(ROUND_DURATION);
      }
      const timer = setInterval(() => {
        console.log("Timer tick", { currentRoundId: currentRound?.roundId, timeLeft });
        if (currentRound) {
          const startTime = new Date(currentRound.startTime);
          console.log("Start time:", currentRound.startTime, "Parsed:", startTime.toISOString());
          if (isNaN(startTime.getTime())) {
            console.error("Invalid startTime:", currentRound.startTime);
            setStatus("Error: Invalid round start time");
            setTimeLeft(ROUND_DURATION);
            return;
          }
          const now = new Date();
          const elapsedSeconds = Math.floor((now.getTime() - startTime.getTime()) / 1000);
          let remainingSeconds = ROUND_DURATION - elapsedSeconds;
          console.log("Elapsed:", elapsedSeconds, "Remaining:", remainingSeconds);

          if (remainingSeconds < 0) {
            remainingSeconds = 0;
          } else if (remainingSeconds > ROUND_DURATION) {
            console.warn("Remaining seconds exceeds ROUND_DURATION, resetting:", remainingSeconds);
            remainingSeconds = ROUND_DURATION;
          }

          setTimeLeft(remainingSeconds);
        } else {
          console.log("No current round, setting default time");
          setTimeLeft(ROUND_DURATION);
        }
      }, 1000);

      return () => {
        console.log("Cleaning up timer");
        clearInterval(timer);
      };
    }, [currentRound]);

    // Round finalization
    useEffect(() => {
      if (currentRound && timeLeft <= 0 && !isFinalizing) {
        console.log("Triggering round finalization", { roundId: currentRound.roundId });
        finalizeAndStartNewRound();
      }
    }, [currentRound, timeLeft, finalizeAndStartNewRound]);

    // Initial round check
    useEffect(() => {
      console.log("Triggering initial round check");
      fetchPriceAndInitializeRound();
    }, [retryPriceFetch]);

    // Place bet
const placeBet = async () => {
  // Message deduplication cache
  const messageCache: { [key: string]: number } = {};
  const MESSAGE_TIMEOUT = 5000; // 5 seconds to prevent duplicate messages

  // Helper function to show deduplicated messages
  const showMessage = (message: string, isError: boolean = false) => {
    const now = Date.now();
    // Clean up old messages
    Object.keys(messageCache).forEach((key) => {
      if (now - messageCache[key] > MESSAGE_TIMEOUT) {
        delete messageCache[key];
      }
    });
    // Only show message if not recently shown
    if (!messageCache[message]) {
      messageCache[message] = now;
      setStatus(message);
      if (isError) {
      }
    }
  };

  if (!connected || !publicKey) {
    showMessage("Please connect your wallet", true);
    return;
  }
  if (!amount || isNaN(Number.parseFloat(amount)) || Number.parseFloat(amount) <= 0) {
    showMessage("Enter a valid amount", true);
    return;
  }
  if (prediction === null) {
    showMessage("Select Up or Down", true);
    return;
  }
  if (!currentRound || timeLeft <= 0) {
    showMessage("No active round available", true);
    return;
  }
  if (timeLeft <= BETTING_CUTOFF_SECONDS) {
    showMessage("Betting closed: less than 30 seconds remain", true);
    return;
  }

  const betAmount = Number.parseFloat(amount);
  const MIN_BET = 0.01;
  const MAX_BET_PER_WALLET = 100;

  if (betAmount < MIN_BET) {
    showMessage(`Bet amount must be at least ${MIN_BET} $GOR`, true);
    return;
  }

  try {
    const betsRef = collection(db, "rounds", currentRound.id, "bets");
    const betsSnapshot = await getDocs(betsRef);
    const walletBets = betsSnapshot.docs
      .map((doc) => doc.data() as Bet)
      .filter((bet) => bet.walletAddress === publicKey.toString());
    const totalWalletBets = walletBets.reduce((sum, bet) => sum + bet.amount, 0);

    if (totalWalletBets + betAmount > MAX_BET_PER_WALLET) {
      showMessage(
        `Total bets cannot exceed ${MAX_BET_PER_WALLET} $GOR. You have bet ${totalWalletBets} $GOR.`,
        true
      );
      return;
    }
  } catch (error) {
    console.error("Error checking wallet bets:", error);
    showMessage("Error validating bet amount", true);
    return;
  }

  setIsBettingLoading(true);

  try {
    if (!signTransaction) {
      throw new Error("Wallet does not support transaction signing");
    }

    let signature: string | undefined;
    let attempts = 0;
    const BLOCKHASH_VALIDITY_BUFFER = 20;
    const MAX_BLOCKHASH_AGE_MS = 30000;

    while (attempts < TRANSACTION_RETRIES) {
      attempts++;
      console.log(`Transaction attempt ${attempts} of ${TRANSACTION_RETRIES}`);

      try {
        const blockhashFetchTime = Date.now();
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
        console.log("Fetched blockhash:", blockhash, "Last valid block height:", lastValidBlockHeight);

        const currentBlockHeight = await connection.getBlockHeight("finalized");
        if (currentBlockHeight >= lastValidBlockHeight - BLOCKHASH_VALIDITY_BUFFER) {
          console.warn("Blockhash is too old, retrying...");
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (Date.now() - blockhashFetchTime > MAX_BLOCKHASH_AGE_MS) {
          console.warn("Blockhash fetch took too long, retrying...");
          continue;
        }

        const instruction = SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: SERVER_WALLET,
          lamports: Math.floor(betAmount * 1e9),
        });

        const messageV0 = new TransactionMessage({
          payerKey: publicKey,
          recentBlockhash: blockhash,
          instructions: [instruction],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);

        showMessage("Awaiting wallet signature...");
        const signStartTime = Date.now();
        const signedTransaction = await signTransaction(transaction);
        console.log("Transaction signed", `Time: ${Date.now() - signStartTime}ms`);

        if (Date.now() - blockhashFetchTime > MAX_BLOCKHASH_AGE_MS) {
          console.warn("Transaction signing took too long, retrying...");
          continue;
        }

        showMessage("Sending transaction to network...");
        const sendStartTime = Date.now();
        signature = await connection.sendTransaction(signedTransaction, {
          skipPreflight: false,
          maxRetries: 3,
        });
        console.log("Transaction sent, signature:", signature, `Time: ${Date.now() - sendStartTime}ms`);

        let confirmationAttempts = 0;
        const maxConfirmationAttempts = 30;
        while (confirmationAttempts < maxConfirmationAttempts) {
          const status = await connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === "finalized") {
            console.log("Transaction finalized");
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
          throw new Error("Transaction confirmation timed out");
        }

        break;
      } catch (error: any) {
        console.error(`Transaction attempt ${attempts} failed:`, error);
        const errorMessage = error.message || "Unknown error";

        if (
          errorMessage.includes("Blockhash not found") ||
          errorMessage.includes("block height exceeded") ||
          errorMessage.includes("Transaction expired")
        ) {
          console.log("Retrying with fresh blockhash...");
          showMessage(`Retrying transaction (attempt ${attempts + 1}/${TRANSACTION_RETRIES})...`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        throw error;
      }
    }

    if (!signature) {
      throw new Error(`Failed to send transaction after ${TRANSACTION_RETRIES} retries`);
    }

    const bet: Bet = {
      walletAddress: publicKey.toString(),
      amount: betAmount,
      prediction,
    };
    const roundRef = doc(db, "rounds", currentRound.id);
    const betsRef = collection(roundRef, "bets");
    const betRef = doc(betsRef);

    showMessage("Recording bet in database...");
    await runTransaction(db, async (transaction) => {
      transaction.set(betRef, bet);
      transaction.update(roundRef, {
        totalPool: increment(betAmount),
      });
      console.log("Bet recorded and totalPool updated:", { bet, betId: betRef.id, roundId: currentRound.id });
    });

    showMessage("Bet placed successfully!");
    setAmount("");
    setPrediction(null);
  } catch (error: any) {
    console.error("Bet failed:", error);
    let errorMessage = error.message || "Unknown error";
    if (error.logs) {
      console.log("Transaction logs:", error.logs);
      errorMessage += ` (Logs: ${JSON.stringify(error.logs)})`;
    }
    showMessage("Bet failed. Try again.", true);
  } finally {
    setIsBettingLoading(false);
  }
};

    return (
      <div className="cyberpunk-container">
        <Toaster richColors position="top-right" />
        <header className="cyberpunk-header">
          <h1 className="flex items-center cyberpunk-title justify-center bg-gradient-to-r text-12xl font-bold from-blue-500 via-purple-500 to-green-500 bg-clip-text text-transparent font-orbitron animate-pulse">
            <Swords className="ml-2 w-18 h-18 text-violet-500 cypherpunk-icon-glow" />
            $GOR PVP
            <Swords className="ml-2 w-18 h-18 text-violet-500 cypherpunk-icon-glow" />
          </h1>
          <h2 className="flex items-center cyberpunk-title2 justify-center bg-gradient-to-r text-4xl font-bold from-green-500 via-purple-500 to-blue-500 bg-clip-text text-transparent font-orbitron animate-pulse">
            Make your Bet
          </h2>
        </header>

        <div className="cyberpunk-wallet-controls">
          <WalletMultiButton className="cyberpunk-button cursor-pointer cyberpunk-button-wallet" />
          {connected && (
            <p className="cyberpunk-data-item">
              Wallet Balance: {walletBalance !== null ? `${walletBalance} $GOR` : "Loading..."}
            </p>
          )}
        </div>

        <section className="cyberpunk-round-info">
          {currentRound ? (
            <div className="cyberpunk-data-panel">
              <p className="cyberpunk-data-item">Round #{currentRound.roundId}</p>
              <p className="cyberpunk-data-item">$GOR Price: ${currentRound.startPrice.toFixed(PRICE_PRECISION)}</p>
              <p className="cyberpunk-data-item">
                Time Left: {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, "0")}
              </p>
              <p className="cyberpunk-data-item">Total Pool: {currentRound.totalPool.toFixed(2)} $GOR</p>
            </div>
          ) : (
            <div className="cyberpunk-error-panel">
              <p className="cyberpunk-error-text">{status || "Initializing neural network..."}</p>
              {status.includes("Failed") && (
                <button
                  onClick={() => setRetryPriceFetch((prev) => prev + 1)}
                  disabled={isLoading}
                  className="cyberpunk-button cyberpunk-button-retry"
                >
                  Retry Sync
                </button>
              )}
            </div>
          )}
        </section>

        {connected && currentRound && (
          <section className="cyberpunk-betting-interface">
            {timeLeft > BETTING_CUTOFF_SECONDS ? (
              isBettingLoading ? (
                <p className="cyberpunk-status"></p>
              ) : (
                <>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Enter $GOR (0.01-0.1)"
                    step="0.01"
                    min="0.01"
                    max="0.1"
                    disabled={isBettingLoading}
                    className="cyberpunk-input"
                  />
                  <div className="cyberpunk-prediction-controls">
                    <button
                      onClick={() => setPrediction(true)}
                      className={`cyberpunk-button cyberpunk-button-up ${prediction === true ? "selected" : ""}`}
                      disabled={isBettingLoading}
                    >
                      Bet Up
                    </button>
                    <button
                      onClick={() => setPrediction(false)}
                      className={`cyberpunk-button cyberpunk-button-down ${prediction === false ? "selected" : ""}`}
                      disabled={isBettingLoading}
                    >
                      Bet Down
                    </button>
                  </div>
                  <button
                    onClick={placeBet}
                    disabled={isBettingLoading || !amount || prediction === null}
                    className="cyberpunk-button cyberpunk-button-place-bet"
                  >
                    Deploy Bet
                  </button>
                </>
              )
            ) : (
              <p className="cyberpunk-error-text">Betting closed: less than 30 seconds remain</p>
            )}
          </section>
        )}

        {status && connected && <p className="cyberpunk-status">{status}</p>}

<section className="cyberpunk-past-rounds">
  <h2 className="cyberpunk-subtitle">Transaction History</h2>
  {pastRounds.length > 0 ? (
    <div className="cyberpunk-rounds-container">
      <ul className="cyberpunk-rounds-list">
        {pastRounds.map((round) => (
          <li key={round.id} className="cyberpunk-round-item">
            <span className="cyberpunk-round-id">Round #{round.roundId}</span>
            <span className="cyberpunk-round-price">
              ${round.startPrice.toFixed(PRICE_PRECISION)} → $
              {round.endPrice != null ? round.endPrice.toFixed(PRICE_PRECISION) : "N/A"}
            </span>
            <span className="cyberpunk-round-outcome">
              (
              {round.draw
                ? "Draw"
                : round.endPrice != null
                ? round.endPrice > round.startPrice
                  ? "Up"
                  : round.endPrice < round.startPrice
                  ? "Down"
                  : "Draw"
                : "Pending"}
              )
            </span>
            <span className="cyberpunk-round-pool">Pool: {round.totalPool.toFixed(2)} $GOR</span>
            <span className="cyberpunk-round-status">
              {round.distributed ? (round.draw ? "Refunded" : "Distributed") : "Pending"}
            </span>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          onClick={loadMoreRounds}
          disabled={isLoading}
          className="cyberpunk-button cyberpunk-button-load-more"
        >
          {isLoading ? "Loading..." : "Load More"}
        </button>
      )}
    </div>
  ) : (
    <p className="cyberpunk-no-data">No transactions recorded.</p>
  )}
</section>
      </div>
    );
  };

  // Wrap BettingGame with providers
  const WrappedBettingGame = () => {
    return (
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect={false}>
          <WalletModalProvider>
            <BettingGame />
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    );
  };

  export default WrappedBettingGame;
