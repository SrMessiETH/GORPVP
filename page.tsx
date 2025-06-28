"use client";

import type React from "react";
import { useState, useEffect, useCallback } from "react";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
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
import { Swords, Info, ChevronDown, ChevronUp } from "lucide-react";
import "./BettingGame.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

import CustomWalletModal from "./CustomWalletModal";

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
const wallets = [
  new PhantomWalletAdapter(),
  new SolflareWalletAdapter(),
];
const SERVER_WALLET = new PublicKey("BTwMeqRYsnME4jpLFWgCePmBQzPYpciCb19o4gw1BaHG");
const ROUND_DURATION = 300;
const MAX_RETRIES = 1;
const TRANSACTION_RETRIES = 1;
const PRICE_PRECISION = 5;
const BETTING_CUTOFF_SECONDS = 30;
const COINGECKO_TOKEN_ID = "gorbagana";

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

// Utility function to format ISO timestamps
const formatTimestamp = (isoString: string): string => {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      return "Invalid Date";
    }
    return date.toLocaleString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch (error) {
    console.error("Error formatting timestamp:", error);
    return "Invalid Date";
  }
};

// Rules Modal Component
const RulesModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="rules-modal-overlay" onClick={onClose}>
      <div className="rules-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="rules-modal-title">How to Play $GOR PVP</h2>
        <div className="rules-modal-content">
          <p>Welcome to $GOR PVP, a thrilling price prediction game on the Solana blockchain!</p>
          <h3>Game Rules:</h3>
          <ul>
            <li><strong>Objective</strong>: Predict whether the $GOR price will go <strong>Up</strong> or <strong>Down</strong> by the end of a 5-minute round.</li>
            <li><strong>Round Duration</strong>: Each round lasts 5 minutes (300 seconds).</li>
            <li><strong>Betting</strong>:
              <ul>
                <li>Bet between 0.01 and 0.1 $GOR per bet, with a maximum of 100 $GOR total per wallet per round.</li>
                <li>Choose "Up" (price will increase) or "Down" (price will decrease).</li>
                <li>Betting closes 30 seconds before the round ends.</li>
              </ul>
            </li>
            <li><strong>Payouts</strong>:
              <ul>
                <li>If the $GOR price increases, "Up" bets win; if it decreases, "Down" bets win.</li>
                <li>If the price stays the same (draw), all bets are refunded.</li>
                <li>If all bets are on the same prediction, all bets are refunded.</li>
                <li>Winners get their original bet back plus a share of the losing pool, minus a 2.5% fee.</li>
                <li>Unmatched bets (if Up and Down pools are unequal) are partially refunded.</li>
              </ul>
            </li>
            <li><strong>Price Source</strong>: $GOR price is sourced from CoinGecko at the start and end of each round.</li>
            <li><strong>Wallet</strong>: Connect a Solana wallet (e.g., Phantom, Solflare) to place bets and receive payouts.</li>
          </ul>
          <p>Good luck, and may your predictions be profitable!</p>
        </div>
        <button className="rules-modal-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
};

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
  const [isBettingLoading, setIsBettingLoading] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [pastRounds, setPastRounds] = useState<Round[]>([]);
  const [lastRoundId, setLastRoundId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isPreRound, setIsPreRound] = useState<boolean>(false);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState<boolean>(false);
  const [expandedRounds, setExpandedRounds] = useState<{ [key: string]: boolean }>({});
  const [roundBets, setRoundBets] = useState<{ [key: string]: { upCount: number; downCount: number; upTotal: number; downTotal: number } }>({});
  const [currentRoundBets, setCurrentRoundBets] = useState<{ upTotal: number; downTotal: number } | null>(null);

  const PAGE_SIZE = 10;

  // Fetch wallet balance
  const fetchWalletBalance = async () => {
    if (!connected || !publicKey) {
      setWalletBalance(null);
      return;
    }
    try {
      const balance = await connection.getBalance(publicKey);
      const balanceInGor = balance / 1e9;
      setWalletBalance(balanceInGor);
      console.log(`Wallet balance fetched: ${balanceInGor} $GOR`);
    } catch (error) {
      console.error("Error fetching wallet balance:", error);
      setWalletBalance(null);
      toast.error("Failed to fetch wallet balance");
    }
  };

  // Fetch bets for a specific round (for past rounds)
  const fetchBetsForRound = async (roundId: string) => {
    try {
      const betsRef = collection(db, "rounds", roundId, "bets");
      const betsSnapshot = await getDocs(betsRef);
      const bets = betsSnapshot.docs.map((doc) => doc.data() as Bet);
      const upBets = bets.filter((bet) => bet.prediction);
      const downBets = bets.filter((bet) => !bet.prediction);
      const upCount = upBets.length;
      const downCount = downBets.length;
      const upTotal = upBets.reduce((sum, bet) => sum + bet.amount, 0);
      const downTotal = downBets.reduce((sum, bet) => sum + bet.amount, 0);
      console.log(`Bets fetched for round ${roundId}:`, { upCount, downCount, upTotal, downTotal });
      setRoundBets((prev) => ({
        ...prev,
        [roundId]: { upCount, downCount, upTotal, downTotal },
      }));
    } catch (error) {
      console.error(`Error fetching bets for round ${roundId}:`, error);
      toast.error(`Failed to load bets for Round #${roundId}`);
    }
  };

  // Fetch bets for current round in real-time
  useEffect(() => {
    if (!currentRound) {
      setCurrentRoundBets(null);
      return;
    }
    console.log(`Setting up bets listener for round ${currentRound.id}`);
    const betsRef = collection(db, "rounds", currentRound.id, "bets");
    const unsubscribe = onSnapshot(
      betsRef,
      (snapshot) => {
        const bets = snapshot.docs.map((doc) => doc.data() as Bet);
        const upBets = bets.filter((bet) => bet.prediction);
        const downBets = bets.filter((bet) => !bet.prediction);
        const upTotal = upBets.reduce((sum, bet) => sum + bet.amount, 0);
        const downTotal = downBets.reduce((sum, bet) => sum + bet.amount, 0);
        console.log(`Current round bets updated for round ${currentRound.id}:`, { upTotal, downTotal });
        setCurrentRoundBets({ upTotal, downTotal });
      },
      (error) => {
        console.error(`Error listening to bets for round ${currentRound.id}:`, error);
        setCurrentRoundBets({ upTotal: 0, downTotal: 0 });
        toast.error("Failed to load current round bet totals");
      }
    );

    return () => {
      console.log("Cleaning up current round bets listener");
      unsubscribe();
    };
  }, [currentRound]);

  // Toggle round expansion
  const toggleRoundDetails = (roundId: string) => {
    setExpandedRounds((prev) => {
      const isExpanded = !prev[roundId];
      if (isExpanded && !roundBets[roundId]) {
        fetchBetsForRound(roundId);
      }
      return { ...prev, [roundId]: isExpanded };
    });
  };

  // Fetch balance when wallet connects or changes
  useEffect(() => {
    fetchWalletBalance();
  }, [publicKey, connected]);

  // Add keyboard accessibility for RulesModal
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        console.log("Escape key pressed, closing RulesModal");
        setIsRulesModalOpen(false);
      }
    };
    if (isRulesModalOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isRulesModalOpen]);

  useEffect(() => {
    const fixModalAndButtons = () => {
      console.log("Running fixModalAndButtons");
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
      const modalList = modal.querySelector(".wallet-adapter-modal-list") as HTMLElement | null;
      if (modalList) {
        modalList.setAttribute(
          "style",
          `
            display: grid !important;
            grid-template-columns: 1fr !important;
            gap: 8px !important;
            padding: 0 !important;
            margin: 0 !important;
            width: 100% !important;
          `,
        );
      }
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
    fixModalAndButtons();
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
      await fetchWalletBalance();
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
              if (current) {
                const startTime = new Date(current.startTime);
                const now = new Date();
                const elapsedSeconds = Math.floor((now.getTime() - startTime.getTime()) / 1000);
                const remainingSeconds = ROUND_DURATION - elapsedSeconds;
                setTimeLeft(remainingSeconds > 0 ? remainingSeconds : 0);
                setIsPreRound(elapsedSeconds < 0);
                setStatus(elapsedSeconds < 0 ? `Round #${current.roundId} starts in ${Math.abs(elapsedSeconds)} seconds` : "");
              }
              return current || null;
            }
            return prev;
          });

          const past = rounds
            .filter((round) => round.endPrice != null)
            .sort((a, b) => b.roundId - a.roundId)
            .slice(0, PAGE_SIZE);
          console.log("Past rounds:", past);
          setPastRounds(past);

          if (past.length > 0) {
            setLastRoundId(past[past.length - 1].roundId);
            setHasMore(past.length === PAGE_SIZE);
          } else {
            setHasMore(false);
          }

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
    const timer = setInterval(() => {
      console.log("Timer tick", { currentRoundId: currentRound?.roundId, timeLeft });
      if (currentRound) {
        const startTime = new Date(currentRound.startTime);
        console.log("Start time:", currentRound.startTime, "Parsed:", startTime.toISOString());
        if (isNaN(startTime.getTime())) {
          console.error("Invalid startTime:", currentRound.startTime);
          setStatus("Error: Invalid round start time");
          setTimeLeft(ROUND_DURATION);
          setIsPreRound(false);
          return;
        }
        const now = new Date();
        const elapsedSeconds = Math.floor((now.getTime() - startTime.getTime()) / 1000);
        let remainingSeconds = ROUND_DURATION - elapsedSeconds;
        console.log("Elapsed:", elapsedSeconds, "Remaining:", remainingSeconds);

        if (elapsedSeconds < 0) {
          setIsPreRound(true);
          setTimeLeft(ROUND_DURATION);
          setStatus(`Round #${currentRound.roundId} starts in ${Math.abs(elapsedSeconds)} seconds`);
        } else {
          setIsPreRound(false);
          if (remainingSeconds <= 0) {
            remainingSeconds = 0;
            setStatus("Round ended, waiting for new round...");
          } else if (remainingSeconds > ROUND_DURATION) {
            console.warn("Remaining seconds exceeds ROUND_DURATION, resetting:", remainingSeconds);
            remainingSeconds = ROUND_DURATION;
          }
          setTimeLeft(remainingSeconds);
        }
      } else {
        console.log("No current round, setting default time");
        setTimeLeft(ROUND_DURATION);
        setIsPreRound(false);
        setStatus("Waiting for rounds to start...");
      }
    }, 1000);

    return () => {
      console.log("Cleaning up timer");
      clearInterval(timer);
    };
  }, [currentRound]);

  // Initial round check
  useEffect(() => {
    console.log("Triggering initial round check");
    fetchPriceAndInitializeRound();
  }, [retryPriceFetch]);

  // Place bet
  const placeBet = async () => {
    const messageCache: { [key: string]: number } = {};
    const MESSAGE_TIMEOUT = 5000;

    const showMessage = (message: string, isError: boolean = false) => {
      const now = Date.now();
      Object.keys(messageCache).forEach((key) => {
        if (now - messageCache[key] > MESSAGE_TIMEOUT) {
          delete messageCache[key];
        }
      });
      if (!messageCache[message]) {
        messageCache[message] = now;
        setStatus(message);
        if (isError) {
          toast.error(message);
        } else {
          toast.success(message);
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

          const signStartTime = Date.now();
          const signedTransaction = await signTransaction(transaction);
          console.log("Transaction signed", `Time: ${Date.now() - signStartTime}ms`);

          if (Date.now() - blockhashFetchTime > MAX_BLOCKHASH_AGE_MS) {
            console.warn("Transaction signing took too long, retrying...");
            continue;
          }

          const sendStartTime = Date.now();
          signature = await connection.sendTransaction(signedTransaction, {
            skipPreflight: false,
            maxRetries: 3,
          });
          console.log("Transaction sent, signature:", signature, "Time:", Date.now() - sendStartTime, "ms");

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
      await fetchWalletBalance();
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
        <button
          className="cyberpunk-button cyberpunk-button-rules"
          onClick={() => {
            console.log("Rules button clicked, opening modal");
            setIsRulesModalOpen(true);
          }}
        >
          <Info className="w-5 h-5 mr-2" />
          Rules
        </button>
        {connected && (
          <p className="cyberpunk-data-item">
            Wallet Balance: {walletBalance !== null ? `${walletBalance} $GOR` : "Loading..."}
          </p>
        )}
      </div>

<section className="round-info-section">
  {currentRound ? (
    <div className="round-info-grid-container">
      <div className="round-info-grid-header">
        <h3 className="round-info-grid-title" aria-label={`Round ${currentRound.roundId}`}>
          Round #{currentRound.roundId}
        </h3>
        <p className="round-info-grid-time" aria-label={`Time left: ${Math.floor(timeLeft / 60)} minutes ${(timeLeft % 60).toString().padStart(2, "0")} seconds`}>
          {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, "0")}
        </p>
      </div>
      <div className="round-info-grid">
        <div className="round-info-grid-item">
          <span className="round-info-grid-label">Start Price</span>
          <span className="round-info-grid-value">${currentRound.startPrice.toFixed(PRICE_PRECISION)}</span>
        </div>
        <div className="round-info-grid-item">
          <span className="round-info-grid-label">Total Pool</span>
          <span className="round-info-grid-value">{currentRound.totalPool.toFixed(2)} $GOR</span>
        </div>
        <div className="round-info-grid-item">
          <span className="round-info-grid-label">Started</span>
          <span className="round-info-grid-value">{formatTimestamp(currentRound.startTime)}</span>
        </div>
        {currentRoundBets ? (
          <>
            <div className="round-info-grid-item">
              <span className="round-info-grid-label">Up Total Bets</span>
              <span className="round-info-grid-value">{currentRoundBets.upTotal.toFixed(2)} $GOR</span>
            </div>
            <div className="round-info-grid-item">
              <span className="round-info-grid-label">Down Total Bets</span>
              <span className="round-info-grid-value">{currentRoundBets.downTotal.toFixed(2)} $GOR</span>
            </div>
          </>
        ) : (
          <div className="round-info-grid-item">
            <span className="round-info-grid-label">Bet Totals</span>
            <span className="round-info-grid-value">Loading...</span>
          </div>
        )}
        {currentRound.endPrice != null && (
          <div className="round-info-grid-item">
            <span className="round-info-grid-label">End Price</span>
            <span className="round-info-grid-value">${currentRound.endPrice.toFixed(PRICE_PRECISION)}</span>
          </div>
        )}
        {currentRound.endTime && (
          <div className="round-info-grid-item">
            <span className="round-info-grid-label">Ended</span>
            <span className="round-info-grid-value">{formatTimestamp(currentRound.endTime)}</span>
          </div>
        )}
        {currentRound.draw != null && (
          <div className="round-info-grid-item">
            <span className="round-info-grid-label">Outcome</span>
            <span className="round-info-grid-value">
              {currentRound.draw ? "Draw" : currentRound.endPrice! > currentRound.startPrice ? "Up" : "Down"}
            </span>
          </div>
        )}
        {currentRound.distributed != null && (
          <div className="round-info-grid-item">
            <span className="round-info-grid-label">Status</span>
            <span className="round-info-grid-value">
              {currentRound.distributed ? (currentRound.draw ? "Refunded" : "Distributed") : "Pending"}
            </span>
          </div>
        )}
      </div>
    </div>
  ) : (
    <div className="round-info-error-container">
      <p className="round-info-error-text">{status || "Initializing neural network..."}</p>
      {status.includes("Failed") && (
        <button
          onClick={() => setRetryPriceFetch((prev) => prev + 1)}
          disabled={isLoading}
          className="round-info-retry-button"
        >
          Retry Sync
        </button>
      )}
    </div>
  )}
</section>

      {connected && currentRound && (
        <section className="cyberpunk-betting-interface">
          {timeLeft > BETTING_CUTOFF_SECONDS || isPreRound ? (
            isBettingLoading ? (
              <p className="cyberpunk-status">Processing bet...</p>
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
          ) : timeLeft > 0 ? (
            <p className="cyberpunk-error-text">Betting closed: less than 30 seconds remain</p>
          ) : null}
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

      <RulesModal isOpen={isRulesModalOpen} onClose={() => {
        console.log("Closing RulesModal");
        setIsRulesModalOpen(false);
      }} />

      <Analytics />
      <SpeedInsights />
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
