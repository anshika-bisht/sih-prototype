const fs = require('fs');
const path = require('path');
const { ethers } = require("hardhat");

async function main() {
  const EvidenceAudit = await ethers.getContractFactory("EvidenceAudit");
  console.log("Deploying EvidenceAudit...");
  const evidenceAudit = await EvidenceAudit.deploy();

  await evidenceAudit.waitForDeployment();

  const address = await evidenceAudit.getAddress();
  console.log("EvidenceAudit deployed to:", address);

  const addressPath = path.join(__dirname, '..', 'contract_address.txt');
  fs.writeFileSync(addressPath, address);
  console.log(`Saved contract address to ${addressPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
