$ErrorActionPreference = "Stop"

Write-Host "================================================="
Write-Host "   Starting CHAKRAVYUH Environment Setup...      "
Write-Host "================================================="

# 1. Setup Virtual Environment
if (!(Test-Path "venv")) {
    Write-Host "[*] Creating Python virtual environment (venv)..."
    python -m venv venv
} else {
    Write-Host "[*] Virtual environment already exists. Skipping creation."
}

# 2. Install Python dependencies
Write-Host "[*] Installing/Verifying backend dependencies..."
.\venv\Scripts\python.exe -m pip install -r backend\requirements.txt

# 3. Check ML Models (spaCy)
Write-Host "[*] Checking ML Models (spaCy)..."
.\venv\Scripts\python.exe -c "import spacy; spacy.load('en_core_web_sm')" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[*] Downloading ML Models (spaCy)..."
    .\venv\Scripts\python.exe -m spacy download en_core_web_sm
}

# 4. Check Hardhat dependencies
Write-Host "[*] Checking Hardhat dependencies..."
Set-Location backend\blockchain\hardhat-env
if (!(Test-Path "node_modules")) {
    Write-Host "[*] Installing Hardhat Node dependencies..."
    npm install
} else {
    Write-Host "[*] Hardhat node_modules already exists. Skipping installation."
}
Set-Location ..\..\..

Write-Host "================================================="
Write-Host "   Starting CHAKRAVYUH Services...               "
Write-Host "================================================="

# 5. Start Blockchain Node (Hardhat)
Write-Host "[*] Starting Hardhat Local Blockchain on port 8545..."
Set-Location backend\blockchain\hardhat-env
$hardhatProcess = Start-Process -FilePath "npx.cmd" -ArgumentList "hardhat node" -NoNewWindow -PassThru
Start-Sleep -Seconds 5
Write-Host "[*] Compiling and Deploying Smart Contract..."
npx hardhat run scripts\deploy.js --network localhost
Set-Location ..\..\..

# 6. Start Backend
Write-Host "[*] Starting FastAPI Backend on port 8000..."
Set-Location backend
$backendProcess = Start-Process -FilePath "..\venv\Scripts\python.exe" -ArgumentList "-m uvicorn app:app --reload --host 0.0.0.0 --port 8000" -NoNewWindow -PassThru
Set-Location ..

# 7. Start Frontend
Write-Host "[*] Starting Frontend Server on port 8080 with Live Reload..."
Set-Location frontend
$frontendProcess = Start-Process -FilePath "npx.cmd" -ArgumentList "-y live-server --port=8080 --no-browser" -NoNewWindow -PassThru
Set-Location ..

Write-Host "================================================="
Write-Host " SUCCESS! CHAKRAVYUH is now running."
Write-Host " "
Write-Host " ▶ Frontend UI: http://localhost:8080"
Write-Host " ▶ Backend API: http://localhost:8000/docs"
Write-Host " "
Write-Host " Login Credentials: admin / admin"
Write-Host " "
Write-Host " Press Ctrl+C to stop all services."
Write-Host "================================================="

try {
    while ($true) {
        Start-Sleep -Seconds 1
    }
} finally {
    Write-Host "Stopping services..."
    Stop-Process -Id $hardhatProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $frontendProcess.Id -Force -ErrorAction SilentlyContinue
}
