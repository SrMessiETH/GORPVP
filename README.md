# $GOR PVP Betting Game

## Game Overview

$GOR PVP is a decentralized betting game built on the Solana blockchain, integrated with the Gorbagana token ($GOR). Players predict whether the $GOR price will go up or down within a 5-minute round. Bets are placed in $GOR, and the game features:

- **Real-time price feeds** via CoinGecko for $GOR/USD.
- **Transparent rounds** stored on Firebase Firestore.
- **Payouts** distributed automatically to winners (97.5% of the pool) or refunded in case of a draw.
- **Wallet integration** with Phantom, Solflare, and Backpack via Solana Wallet Adapter.
- **Cyberpunk-themed UI** with a responsive, immersive design.

Each round lasts 300 seconds, with a 30-second betting cutoff. Players can bet between 0.01 and 100 $GOR per transaction.

## Gorbagana Integration

The game is tightly integrated with the Gorbagana ecosystem:

- **Token**: Uses $GOR as the native betting currency.
- **RPC Endpoint**: Connects to `https://rpc.gorbagana.wtf` for Solana blockchain interactions.
- **Price Oracle**: Fetches $GOR/USD prices from CoinGecko (ID: `gorbagana`) with 5-decimal precision.
- **Server Wallet**: A designated Solana wallet (`Ckfc67xpyWz4nHEkDzGuyoqFhNTg2gEBLEpmi8eoA1av`) handles bet collection and payouts.
- **Transaction Security**: Implements retry logic (up to 5 attempts) for transaction finality and blockhash validity checks to ensure reliability on the Gorbagana network.

## Instructions to Run Locally

### Prerequisites
- **Node.js** (v16 or higher)
- **npm** or **yarn**
- **Git**
- **Firebase account** with Firestore enabled
- **Solana wallet** with $GOR for testing
- **Phantom, Solflare, or Backpack wallet** installed in your browser

### Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/your-username/GORPVP.git
   cd gor-pvp

   Install Dependencies:
bash

npm install

or
bash

yarn install

Configure Environment Variables:
Create a .env.local file in the project root.

Replace Firebase values with your Firebase project credentials.

Run Locally:
bash

npm run dev

or
bash

yarn dev

The app will be available at http://localhost:3000.

You are going to need the index.js back-end server on a firebase function or node/pm2 (making the needed changes) that runs every two minutes.

Connect Wallet:
Open the app in a browser with Phantom, Solflare, or Backpack installed.

Click the wallet button to connect and start betting.

Notes
Ensure your wallet has $GOR for betting and transaction fees.

The app uses the Gorbagana RPC endpoint (https://rpc.gorbagana.wtf). Ensure it's operational.

For development, you can test with small $GOR amounts (e.g., 0.01 $GOR).

Access the Demo
A live demo is not currently hosted. To experience $GOR PVP:
Follow the steps above to run locally.

Alternatively, check the project's GitHub Discussions or X posts (@Gorbagana_chain) for updates on a hosted demo.

Contributing
Contributions are welcome! Please:
Fork the repository.

Create a feature branch (git checkout -b feature/your-feature).

Commit changes (git commit -m 'Add your feature').

Push to the branch (git push origin feature/your-feature).

Open a Pull Request.

License
This project is licensed under the MIT License. See the LICENSE file for details.

This README provides a clear overview of the $GOR PVP game, details its integration with the Gorbagana ecosystem, and includes step-by-step instruction.

