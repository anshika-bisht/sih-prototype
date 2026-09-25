# CHAKRAVYUH AI-Powered Criminal Network Analysis System

## Overview
CHAKRAVYUH is a cutting-edge law enforcement portal designed to analyze criminal networks using NLP entity extraction, graph database modeling (Neo4j), and blockchain-backed evidence auditing (Hardhat/Ethereum). It features an advanced intelligence graph powered by Cytoscape.js and geospatial mapping via Leaflet.js.

## Prerequisites
- **Python 3.10+** (Added to system PATH)
- **Node.js & npm**
- **Neo4j Desktop / Server** running locally at `bolt://localhost:7687` (Default credentials: `neo4j` / `password`)

## Quick Start

We provide automated setup scripts to configure the environment, install required dependencies, and start all necessary services with a single command.

### **Mac / Linux**
Open your terminal and run the shell script:
```bash
./run.sh
```

### **Windows**
Open **PowerShell** (you can right-click the folder and select "Open in Terminal") and run the script:
```powershell
.\run.ps1
```
*(Note: If you get an execution policy error, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first).*

**What the setup scripts do:**
- Detects your system and sets up a Python virtual environment automatically if one does not exist.
- Installs all Python dependencies and downloads required ML models (`spaCy`).
- Installs necessary Node.js modules for the local blockchain if missing.
- Boots up the Hardhat local blockchain and deploys the smart contract.
- Starts the FastAPI Backend server.
- Starts the Frontend UI server.

## Manual Setup (If you prefer not to use `run.sh`)

### 1. Start Neo4j
Ensure your Neo4j database is running and accessible at `bolt://localhost:7687`.
   
### 2. Setup Python Virtual Environment
**Mac/Linux:**
```bash
python3 -m venv venv
source venv/bin/activate
```

**Windows (Command Prompt / PowerShell):**
```cmd
python -m venv venv
venv\Scripts\activate
```

**Install Dependencies (All OS):**
```bash
pip install -r ./backend/requirements.txt
python -m spacy download en_core_web_sm
```

### 3. Start the Blockchain Node
```bash
cd backend/blockchain/hardhat-env
npm install
npx hardhat node
```
Open a new terminal, activate your `venv`, and deploy the contract:
```bash
cd backend/blockchain/hardhat-env
npx hardhat run scripts/deploy.js --network localhost
```

### 4. Start the FastAPI Backend
Open a new terminal and activate your `venv`:
```bash
cd backend
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

### 5. Serve the Frontend
Open a new terminal:
```bash
cd frontend
npx -y live-server --port=8080
```
Navigate to `http://localhost:8080` in your web browser.

## Data Ingestion
Drop `.txt` files into `data-gen/firs/`. 
Use the API to ingest and extract data:
```bash
curl -X POST http://localhost:8000/api/ingest \
-H "Content-Type: application/json" \
-d '{"text": "FIR NO: FIR-2026-DEL-0101. Accused Aarnav Kandda transferred money to bank IFSC HDFC0001234.", "case_id": "FIR-2026-DEL-0101", "filename": "upload1.txt"}'
```

## UI Access
- Username: `admin`
- Password: `admin`
