#!/bin/bash

echo "================================================="
echo "   Starting CHAKRAVYUH Environment Setup...      "
echo "================================================="

# Detect OS
if [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* || "$OSTYPE" == "mingw"* ]]; then
    echo "[!] Error: You are on Windows. Please use .\run.ps1 via PowerShell."
    exit 1
fi

PYTHON_CMD="python3"
VENV_ACTIVATE="venv/bin/activate"

# Check if Python is installed
if ! command -v $PYTHON_CMD &> /dev/null; then
    echo "[!] Error: $PYTHON_CMD is not installed or not in PATH."
    exit 1
fi

# Check if Node.js is installed
if ! command -v npm &> /dev/null; then
    echo "[!] Error: npm (Node.js) is not installed or not in PATH."
    exit 1
fi

# 1. Setup Virtual Environment in the root directory
if [ ! -d "venv" ]; then
    echo "[*] Creating Python virtual environment (venv)..."
    $PYTHON_CMD -m venv venv
else
    echo "[*] Virtual environment already exists. Skipping creation."
fi

echo "[*] Activating virtual environment..."
source $VENV_ACTIVATE

echo "[*] Installing/Verifying backend dependencies..."
pip install -r backend/requirements.txt

echo "[*] Checking ML Models (spaCy)..."
python -c "import spacy; spacy.load('en_core_web_sm')" 2>/dev/null || {
    echo "[*] Downloading ML Models (spaCy)..."
    python -m spacy download en_core_web_sm
}

echo "[*] Checking Hardhat dependencies..."
cd backend/blockchain/hardhat-env
if [ ! -d "node_modules" ]; then
    echo "[*] Installing Hardhat Node dependencies..."
    npm install
else
    echo "[*] Hardhat node_modules already exists. Skipping installation."
fi
cd ../../..

echo "================================================="
echo "   Starting CHAKRAVYUH Services...               "
echo "================================================="

# 2. Start Blockchain Node (Hardhat)
echo "[*] Starting Hardhat Local Blockchain on port 8545..."
cd backend/blockchain/hardhat-env
npx hardhat node > /dev/null 2>&1 &
HARDHAT_PID=$!
sleep 4
echo "[*] Compiling and Deploying Smart Contract..."
npx hardhat run scripts/deploy.js --network localhost
cd ../../..

# 3. Start Backend
echo "[*] Starting FastAPI Backend on port 8000..."
cd backend
# Start uvicorn in the background
uvicorn app:app --reload --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
cd ..

# 4. Start Frontend
echo "[*] Starting Frontend Server on port 8080 with Live Reload..."
cd frontend
# Start live-server in the background for auto-refresh
npx -y live-server --port=8080 --no-browser &
FRONTEND_PID=$!
cd ..

echo "================================================="
echo " SUCCESS! CHAKRAVYUH is now running."
echo " "
echo " ▶ Frontend UI: http://localhost:8080"
echo " ▶ Backend API: http://localhost:8000/docs"
echo " "
echo " Login Credentials: admin / admin"
echo " "
echo " Press Ctrl+C to stop all services."
echo "================================================="

# Handle termination gracefully
trap "echo 'Stopping services...'; kill $BACKEND_PID $FRONTEND_PID $HARDHAT_PID 2>/dev/null; exit" EXIT INT TERM
wait
