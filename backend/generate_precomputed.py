import os
import json
import logging
import sys

# Force enable full NLP
os.environ["ENABLE_LIGHTWEIGHT_NLP"] = "false"
os.environ["ENABLE_BERT_NER"] = "true"

from nlp_pipeline.extractors import extract_all
from nlp_pipeline.linker import extract_relationships

firs_dir = os.path.join("..", "data-gen", "firs")
demo_files = sorted(f for f in os.listdir(firs_dir) if f.endswith(".txt"))

dataset = {
    "analysis_mode": "precomputed",
    "pipeline_version": "1.0",
    "cases": []
}

for fname in demo_files:
    case_id = fname.replace(".txt", "")
    fpath = os.path.join(firs_dir, fname)
    with open(fpath, "r", encoding="utf-8") as f:
        text = f.read()
    
    # Run full pipeline
    print(f"Processing {fname} with FULL pipeline...")
    entities, _ = extract_all(text)
    relationships, aliases = extract_relationships(text, entities, case_id)
    
    dataset["cases"].append({
        "case_id": case_id,
        "entities": entities,
        "relationships": relationships,
        "aliases": aliases
    })

os.makedirs("data", exist_ok=True)
with open("data/precomputed_demo_analysis.json", "w") as f:
    json.dump(dataset, f, indent=2)

print("Precomputed dataset generated successfully in backend/data/precomputed_demo_analysis.json.")
