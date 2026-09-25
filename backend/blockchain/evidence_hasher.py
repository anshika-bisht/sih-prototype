import os
import json
import hashlib
from web3 import Web3

RPC_URL = "http://127.0.0.1:8545"
FALLBACK_FILE = "blockchain_ledger.json"

class BlockchainAuditor:
    def __init__(self):
        self.w3 = Web3(Web3.HTTPProvider(RPC_URL))
        self.contract_address = None
        self.contract_abi = None

        try:
            with open("blockchain/hardhat-env/artifacts/contracts/EvidenceAudit.sol/EvidenceAudit.json") as f:
                contract_json = json.load(f)
                self.contract_abi = contract_json["abi"]
            with open("blockchain/hardhat-env/contract_address.txt") as f:
                self.contract_address = f.read().strip()
                
            if self.w3.is_connected() and self.contract_address:
                self.contract = self.w3.eth.contract(address=self.contract_address, abi=self.contract_abi)
                self.account = self.w3.eth.accounts[0]
            else:
                self.contract = None
        except Exception as e:
            print(f"Blockchain setup failed, using fallback. Error: {e}")
            self.contract = None

        if not os.path.exists(FALLBACK_FILE):
            with open(FALLBACK_FILE, "w") as f:
                json.dump({}, f)

    def hash_file(self, filepath: str) -> str:
        hasher = hashlib.sha256()
        with open(filepath, 'rb') as f:
            buf = f.read()
            hasher.update(buf)
        return hasher.hexdigest()

    def reseed_ledger_hashes(self):
        base_dir = os.path.join("..", "data-gen")
        for root, dirs, files in os.walk(base_dir):
            for filename in files:
                filepath = os.path.join(root, filename)
                file_hash = self.hash_file(filepath)
                
                case_id = "SYSTEM_BASELINE"
                if "FIR" in filename:
                    case_id = filename.split(".")[0]
                    
                self.log_evidence(file_hash, case_id)

    def log_evidence(self, file_hash: str, case_id: str):
        import time
        timestamp = int(time.time())
        
        if self.contract and self.w3.is_connected():
            try:
                # Check if evidence is already logged
                record = self.contract.functions.getEvidence(file_hash).call()
                exists = record[3]
                if exists:
                    return {"status": "SUCCESS", "type": "BLOCKCHAIN", "hash": file_hash}

                tx_hash = self.contract.functions.logEvidence(file_hash, case_id).transact({'from': self.account})
                self.w3.eth.wait_for_transaction_receipt(tx_hash)
                return {"status": "SUCCESS", "type": "BLOCKCHAIN", "hash": file_hash}
            except Exception as e:
                print(f"Contract execution failed: {e}")

        with open(FALLBACK_FILE, "r") as f:
            ledger = json.load(f)
            
        ledger[file_hash] = {
            "caseId": case_id,
            "timestamp": timestamp,
            "sender": "FALLBACK_SYSTEM"
        }
        
        with open(FALLBACK_FILE, "w") as f:
            json.dump(ledger, f, indent=4)
            
        return {"status": "SUCCESS", "type": "FALLBACK", "hash": file_hash}
        
    def verify_evidence(self, file_hash: str):
        if self.contract and self.w3.is_connected():
            try:
                record = self.contract.functions.getEvidence(file_hash).call()
                if record[3]: 
                    return {"verified": True, "type": "BLOCKCHAIN", "caseId": record[0], "timestamp": record[1], "sender": record[2]}
            except Exception as e:
                pass

        with open(FALLBACK_FILE, "r") as f:
            ledger = json.load(f)
            
        if file_hash in ledger:
            data = ledger[file_hash]
            return {"verified": True, "type": "FALLBACK", "caseId": data["caseId"], "timestamp": data["timestamp"], "sender": data["sender"]}
            
        return {"verified": False}
