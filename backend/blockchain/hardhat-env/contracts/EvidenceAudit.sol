// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract EvidenceAudit {
    struct Record {
        string caseId;
        uint256 timestamp;
        address sender;
        bool exists;
    }
    
    mapping(string => Record) public evidenceRecords;
    
    event EvidenceLogged(string fileHash, string caseId, uint256 timestamp, address sender);
    
    function logEvidence(string memory fileHash, string memory caseId) public {
        require(!evidenceRecords[fileHash].exists, "Evidence already logged");
        
        evidenceRecords[fileHash] = Record({
            caseId: caseId,
            timestamp: block.timestamp,
            sender: msg.sender,
            exists: true
        });
        
        emit EvidenceLogged(fileHash, caseId, block.timestamp, msg.sender);
    }
    
    function getEvidence(string memory fileHash) public view returns (string memory, uint256, address, bool) {
        Record memory record = evidenceRecords[fileHash];
        return (record.caseId, record.timestamp, record.sender, record.exists);
    }
}
