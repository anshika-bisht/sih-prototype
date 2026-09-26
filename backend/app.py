from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import os, re
import uvicorn
from pydantic import BaseModel

from nlp_pipeline.extractors import extract_all, extract_regex_only
from nlp_pipeline.linker import extract_relationships, nlp as _spacy_nlp
from database.neo4j_client import Neo4jClient
from blockchain.evidence_hasher import BlockchainAuditor

app = FastAPI(title="CHAKRAVYUH API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

db_client = Neo4jClient()
auditor = BlockchainAuditor()
auditor.reseed_ledger_hashes()

_graph_cache = {"nodes": [], "edges": []}
_node_index = {}   

def _node_id(ent_type: str, value: str) -> str:
    return f"{ent_type}::{value}"

def _add_to_memory_graph(entities: list, relationships: list, case_id: str):
    """Merge extracted entities/relationships into the in-memory graph cache."""
    global _graph_cache, _node_index

    case_key = _node_id("CASE", case_id)
    if case_key not in _node_index:
        nid = f"n{len(_node_index)}"
        _node_index[case_key] = nid
        _graph_cache["nodes"].append({
            "data": {"id": nid, "type": "CASE", "label": case_id,
                     "case_ids": [case_id], "pageRank": 0, "betweenness": 0}
        })

    for ent in entities:
        key = _node_id(ent["type"], ent["value"])
        if key not in _node_index:
            nid = f"n{len(_node_index)}"
            _node_index[key] = nid
            _graph_cache["nodes"].append({
                "data": {"id": nid, "type": ent["type"], "label": ent["value"],
                         "case_ids": [case_id], "pageRank": 0, "betweenness": 0}
            })
        else:
            
            nid = _node_index[key]
            for node in _graph_cache["nodes"]:
                if node["data"]["id"] == nid:
                    if case_id not in (node["data"].get("case_ids") or []):
                        node["data"]["case_ids"] = (node["data"].get("case_ids") or []) + [case_id]
                    break

    for rel in relationships:
        src = rel["source"]
        tgt = rel["target"]
        src_key = _node_id(src["type"], src["value"])
        tgt_key = _node_id(tgt["type"], tgt["value"])
        if src_key in _node_index and tgt_key in _node_index:
            src_id = _node_index[src_key]
            tgt_id = _node_index[tgt_key]
            
            edge = {"data": {"source": src_id, "target": tgt_id, "type": rel["type"], "explanation": rel.get("explanation", "")}}
            existing = {(e["data"]["source"], e["data"]["target"], e["data"]["type"])
                        for e in _graph_cache["edges"]}
            if (src_id, tgt_id, rel["type"]) not in existing:
                _graph_cache["edges"].append(edge)

def _boot_ingest_all_firs():
    """Synchronous boot ingestion using the already-loaded spaCy model + regex.
    Reuses the nlp singleton from linker.py — no double loading."""
    firs_dir = os.path.join("..", "data-gen", "firs")
    if not os.path.isdir(firs_dir):
        print("[BOOT] No FIR directory found, skipping.")
        return

    files = sorted(f for f in os.listdir(firs_dir) if f.endswith(".txt"))
    print(f"[BOOT] Processing {len(files)} FIR files with spaCy + regex...")
    label_map = {"PERSON": "PERSON", "ORG": "ORGANIZATION",
                 "GPE": "LOCATION", "LOC": "LOCATION"}

    for fname in files:
        case_id = fname.replace(".txt", "")
        fpath = os.path.join(firs_dir, fname)
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()

            entities, _ = extract_regex_only(text)

            if _spacy_nlp:
                marker = "INCIDENT NARRATIVE:"
                if marker in text:
                    offset = text.index(marker) + len(marker)
                    narrative = text[offset:]
                else:
                    offset, narrative = 0, text
                doc = _spacy_nlp(narrative)
                for ent in doc.ents:
                    if ent.label_ in label_map and len(ent.text.strip()) >= 3:
                        entities.append({
                            "type": label_map[ent.label_],
                            "value": ent.text.strip(),
                            "start": offset + ent.start_char,
                            "end": offset + ent.end_char
                        })

            relationships, aliases = extract_relationships(text, entities, case_id)
            _add_to_memory_graph(entities, relationships + aliases, case_id)
        except Exception as e:
            print(f"[BOOT] Skipped {fname}: {e}")

    print(f"[BOOT] Done — {len(_graph_cache['nodes'])} nodes, {len(_graph_cache['edges'])} edges")

def _compute_metrics():
    nodes = _graph_cache["nodes"]
    edges = _graph_cache["edges"]
    deg = {n["data"]["id"]: 0 for n in nodes}
    for e in edges:
        deg[e["data"]["source"]] += 1
        deg[e["data"]["target"]] += 1
        
    if not deg: return
    max_deg = max(deg.values()) if max(deg.values()) > 0 else 1
    
    for n in nodes:
        d = deg[n["data"]["id"]]
        n["data"]["degree"] = d
        
        n["data"]["pageRank"] = (d / max_deg) * 0.85  
        
        n["data"]["betweenness"] = d * d * 3

_boot_ingest_all_firs()
auditor.reseed_ledger_hashes()
_compute_metrics()

@app.get("/api/cases")
def get_cases():
    firs_dir = os.path.join("..", "data-gen", "firs")
    active = []
    closed = []

    if os.path.isdir(firs_dir):
        for fname in sorted(os.listdir(firs_dir)):
            if not fname.endswith(".txt"):
                continue
            case_id = fname.replace(".txt", "")
            fpath = os.path.join(firs_dir, fname)
            offense = "Unknown Offense"
            io_name = "Unknown IO"
            date_str = "Unknown Date"
            status = "OPEN"
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                m = re.search(r"INVESTIGATING OFFICER:\s*(.+)", content)
                if m: io_name = m.group(1).strip()
                m = re.search(r"DATE(?:\s*&\s*TIME)?:\s*(.+)", content)
                if m: date_str = m.group(1).strip()[:10]
                m = re.search(r"STATUS:\s*(.+)", content)
                if m: status = m.group(1).strip()
                m = re.search(r"OFFENSE(?: / SECTIONS)?:\s*(.+)", content)
                if m: offense = m.group(1).strip()
            except Exception:
                pass

            entry = {
                "id": case_id,
                "io": io_name,
                "date": date_str,
                "status": status,
                "offense": offense,
                "files": get_case_files(case_id)
            }
            if "CLOSED" in status.upper():
                closed.append(entry)
            else:
                active.append(entry)

    return {"active": active, "closed": closed}

import mimetypes

@app.get("/api/document/{filename}")
def get_document(filename: str):
    base_dir = os.path.join("..", "data-gen")
    for root, dirs, files in os.walk(base_dir):
        if filename in files:
            file_path = os.path.join(root, filename)

            mime_type, _ = mimetypes.guess_type(file_path)
            if not mime_type:
                mime_type = "text/plain" 
                
            return FileResponse(
                file_path, 
                media_type=mime_type, 
                headers={"Content-Disposition": f'inline; filename="{filename}"'}
            )
    raise HTTPException(status_code=404, detail="File not found")

@app.get("/api/files/{case_id}")
def get_case_files(case_id: str):
    base_dir = os.path.join("..", "data-gen")
    linked_files = []
    for root, dirs, files in os.walk(base_dir):
        for f in files:
            file_path = os.path.join(root, f)
            if case_id in f:
                linked_files.append(f)
                continue
            try:
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as doc:
                    content = doc.read()
                    if case_id in content:
                        linked_files.append(f)
            except Exception:
                pass
    return list(set(linked_files))

import io
import PyPDF2

def parse_file_content(filename: str, raw_content: bytes) -> str:
    if filename.lower().endswith('.pdf'):
        try:
            pdf_reader = PyPDF2.PdfReader(io.BytesIO(raw_content))
            text = ""
            for page in pdf_reader.pages:
                extracted = page.extract_text()
                if extracted:
                    text += extracted + "\n"
            return text
        except Exception as e:
            print(f"PDF extraction error: {e}")
            return ""
    return raw_content.decode('utf-8', errors='ignore')

@app.post("/api/extract")
async def extract_data(file: UploadFile = File(...), case_id: str = Form(...)):
    raw_content = await file.read()
    text = parse_file_content(file.filename, raw_content)
    entities, _ = extract_all(text)
    relationships, _ = extract_relationships(text, entities, case_id)
    return {"entities": entities, "relationships": relationships, "text": text}

@app.post("/api/ingest")
async def ingest_data(file: UploadFile = File(...), case_id: str = Form(...)):
    raw_content = await file.read()
    text = parse_file_content(file.filename, raw_content)

    ext = ".pdf" if file.filename.lower().endswith(".pdf") else ".txt"
    filename = f"{case_id}{ext}"

    firs_dir = os.path.join("..", "data-gen", "firs")
    os.makedirs(firs_dir, exist_ok=True)
    file_path = os.path.join(firs_dir, filename)
    with open(file_path, "wb") as f:
        f.write(raw_content)

    entities, _ = extract_all(text)
    relationships, aliases = extract_relationships(text, entities, case_id)

    _add_to_memory_graph(entities, relationships + aliases, case_id)

    db_client.ingest_data(entities, relationships, aliases, case_id)

    if os.path.exists(file_path):
        file_hash = auditor.hash_file(file_path)
        log_res = auditor.log_evidence(file_hash, case_id)
    else:
        log_res = {"status": "FILE_NOT_FOUND"}

    return {"status": "success", "entities": len(entities),
            "relationships": len(relationships), "blockchain": log_res}

@app.get("/api/graph")
def get_graph():
    
    try:
        with db_client.driver.session() as session:
            nodes_res = session.run(
                "MATCH (n) RETURN id(n) as id, labels(n)[0] as type, "
                "n.id as value, n.case_ids as case_ids, "
                "n.pageRank as pageRank, n.betweenness as betweenness"
            )
            edges_res = session.run(
                "MATCH (a)-[r]->(b) RETURN id(a) as source, id(b) as target, type(r) as type, r.explanation as explanation"
            )
            nodes = [{"data": {"id": str(r["id"]), "type": r["type"],
                               "label": r["value"], "case_ids": r["case_ids"],
                               "pageRank": r.get("pageRank", 0),
                               "betweenness": r.get("betweenness", 0)}}
                     for r in nodes_res]
            edges = [{"data": {"source": str(r["source"]),
                               "target": str(r["target"]), "type": r["type"],
                               "explanation": r.get("explanation", "")}}
                     for r in edges_res]
            return {"nodes": nodes, "edges": edges}
    except Exception as e:
        print(f"Neo4j unavailable ({e}), serving in-memory graph.")
        return _graph_cache

class MonitorRequest(BaseModel):
    filenames: list[str]

@app.post("/api/monitor")
def monitor_files(req: MonitorRequest):
    results = {}
    base_dir = os.path.join("..", "data-gen")
    for filename in req.filenames:
        found_path = None
        for root, dirs, files in os.walk(base_dir):
            if filename in files:
                found_path = os.path.join(root, filename)
                break
        if found_path:
            current_hash = auditor.hash_file(found_path)
            res = auditor.verify_evidence(current_hash)
            results[filename] = {
                "status": "SECURE" if res["verified"] else "TAMPERED",
                "hash": current_hash
            }
        else:
            results[filename] = {"status": "MISSING"}
    return results

@app.get("/api/verify/{file_hash}")
def verify_evidence(file_hash: str):
    res = auditor.verify_evidence(file_hash)
    if res["verified"]:
        return res
    raise HTTPException(status_code=404, detail="Evidence not found in ledger")

if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
