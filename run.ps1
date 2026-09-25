# PowerShell script to setup and run CHAKRAVYUH 1 on Windows

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   Starting CHAKRAVYUH Environment Setup...      " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

if (-not (Get-Command "python" -ErrorAction SilentlyContinue)) {
    Write-Host "[!] Error: python is not installed or not in PATH." -ForegroundColor Red
    exit 1
}

if (-not (Get-Command "npm" -ErrorAction SilentlyContinue)) {
    Write-Host "[!] Error: npm (Node.js) is not installed or not in PATH." -ForegroundColor Red
    exit 1
}

# 1. Setup Virtual Environment
if (-not (Test-Path "venv")) {
    Write-Host "[*] Creating Python virtual environment (venv)..."
    python -m venv venv
} else {
    Write-Host "[*] Virtual environment already exists. Skipping creation."
}

Write-Host "[*] Activating virtual environment..."
$env:VIRTUAL_ENV="$PWD\venv"
$env:PATH="$PWD\venv\Scripts;$env:PATH"

Write-Host "[*] Installing/Verifying backend dependencies..."
python -m pip install -r backend/requirements.txt

Write-Host "[*] Checking ML Models (spaCy)..."
$spacyCheck = python -c "import spacy; spacy.load('en_core_web_sm')" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[*] Downloading ML Models (spaCy)..."
    python -m spacy download en_core_web_sm
}

Write-Host "[*] Checking Hardhat dependencies..."
Set-Location "backend\blockchain\hardhat-env"
if (-not (Test-Path "node_modules")) {
    Write-Host "[*] Installing Hardhat Node dependencies..."
    npm install
} else {
    Write-Host "[*] Hardhat node_modules already exists. Skipping installation."
}
Set-Location "..\..\.."

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   Starting CHAKRAVYUH Services...               " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

$processes = @()

# 2. Start Blockchain Node (Hardhat)
Write-Host "[*] Starting Hardhat Local Blockchain on port 8545..."
Set-Location "backend\blockchain\hardhat-env"
$hardhatProcess = Start-Process -FilePath "npx.cmd" -ArgumentList "hardhat node" -NoNewWindow -PassThru
$processes += $hardhatProcess
Start-Sleep -Seconds 5
Write-Host "[*] Compiling and Deploying Smart Contract..."
npx.cmd hardhat run scripts/deploy.js --network localhost
Set-Location "..\..\.."

# 3. Start Backend
Write-Host "[*] Starting FastAPI Backend on port 8000..."
Set-Location "backend"
$backendProcess = Start-Process -FilePath "python" -ArgumentList "-m uvicorn app:app --reload --host 0.0.0.0 --port 8000" -NoNewWindow -PassThru
$processes += $backendProcess
Set-Location ".."

# 4. Start Frontend
Write-Host "[*] Starting Frontend Server on port 8080 with Live Reload..."
Set-Location "frontend"
$frontendProcess = Start-Process -FilePath "npx.cmd" -ArgumentList "-y live-server --port=8080 --no-browser" -NoNewWindow -PassThru
$processes += $frontendProcess
Set-Location ".."

Write-Host "=================================================" -ForegroundColor Green
Write-Host " SUCCESS! CHAKRAVYUH is now running." -ForegroundColor Green
Write-Host " "
Write-Host " > Frontend UI: http://localhost:8080" -ForegroundColor Yellow
Write-Host " > Backend API: http://localhost:8000/docs" -ForegroundColor Yellow
Write-Host " "
Write-Host " Login Credentials: admin / admin"
Write-Host " "
Write-Host " Press Ctrl+C to stop all services." -ForegroundColor Red
Write-Host "=================================================" -ForegroundColor Green

try {
    # Wait indefinitely
    while ($true) { Start-Sleep -Seconds 1 }
} finally {
    Write-Host "`nStopping services..." -ForegroundColor Yellow
    foreach ($p in $processes) {
        if (-not $p.HasExited) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
