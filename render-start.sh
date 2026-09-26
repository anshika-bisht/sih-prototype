#!/bin/bash

# Enforce Render demo environment variables
export ENABLE_LIGHTWEIGHT_NLP=true
export ENABLE_BERT_NER=false
export BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545
export NODE_OPTIONS="--max-old-space-size=256"

# Start the local Hardhat node in the background
cd backend/blockchain/hardhat-env
npx hardhat node > hardhat.log 2>&1 &
HARDHAT_PID=$!

# Wait briefly for Hardhat to spin up
sleep 5

# Deploy the smart contract to the local Hardhat node
npx hardhat run scripts/deploy.js --network localhost

# Navigate back to backend and start the FastAPI server
cd ../..
uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
