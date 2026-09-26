#!/bin/bash

# Enforce Render demo environment variables
export ENABLE_LIGHTWEIGHT_NLP=${ENABLE_LIGHTWEIGHT_NLP:-true}
export ENABLE_BERT_NER=${ENABLE_BERT_NER:-false}
export ENABLE_BLOCKCHAIN=${ENABLE_BLOCKCHAIN:-false}
export BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545
export NODE_OPTIONS="--max-old-space-size=256"

if [ "$ENABLE_BLOCKCHAIN" = "true" ]; then
    echo "[BOOT] Starting local Hardhat blockchain..."
    cd backend/blockchain/hardhat-env
    npx hardhat node > hardhat.log 2>&1 &
    HARDHAT_PID=$!

    # Wait briefly for Hardhat to spin up
    sleep 5

    # Deploy the smart contract to the local Hardhat node
    npx hardhat run scripts/deploy.js --network localhost

    cd ../../..
    cd backend
else
    echo "[BOOT] Blockchain disabled. Skipping Hardhat startup."
    cd backend
fi

# Start the FastAPI server
echo "[BOOT] Starting FastAPI server on port ${PORT:-8000}..."
uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
