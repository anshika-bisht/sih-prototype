import re
from transformers import pipeline

try:
    ner_pipeline = pipeline(
        "ner",
        model="dslim/bert-base-NER",
        aggregation_strategy="first"   
    )
except Exception as e:
    print(f"Error loading BERT model: {e}")
    ner_pipeline = None

_HEADER_LINE_PREFIXES = (
    "STATE:", "DISTRICT:", "POLICE STATION:", "FIR NO:",
    "DATE", "INVESTIGATING OFFICER:", "OFFENSE / SECTIONS:", "STATUS:",
    "FIRST INFORMATION REPORT", "=====", "EVIDENCE RECOVERED",
    "- Digital/Telecom:", "- Financial:", "- Physical:", "INCIDENT NARRATIVE:",
)

def _extract_narrative_only(text: str) -> tuple[str, int]:
    """
    Returns the narrative portion of the text and the character offset
    where it starts, so BERT entity positions can be remapped to the
    full-document offsets correctly.
    """
    marker = "INCIDENT NARRATIVE:"
    if marker in text:
        idx = text.index(marker) + len(marker)
        
        evidence_idx = text.find("EVIDENCE RECOVERED", idx)
        if evidence_idx != -1:
            return text[idx:evidence_idx], idx
        return text[idx:], idx
    return text, 0

def extract_regex_entities(text: str):
    entities = []

    msisdn_pattern = r'\b[6-9]\d{9}\b'
    for match in re.finditer(msisdn_pattern, text):
        entities.append({"type": "PHONE", "value": match.group(0), "start": match.start(), "end": match.end()})

    plate_pattern = r'\b[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,2}[-\s]?\d{4}\b'
    for match in re.finditer(plate_pattern, text):
        val = re.sub(r'[-\s]+', '', match.group(0))
        entities.append({"type": "VEHICLE", "value": val, "start": match.start(), "end": match.end()})

    ifsc_pattern = r'\b[A-Z]{4}0[A-Z0-9]{6}\b'
    for match in re.finditer(ifsc_pattern, text):
        entities.append({"type": "BANK_ACCOUNT", "value": match.group(0), "start": match.start(), "end": match.end()})

    acct_pattern = r'\b[A-Z]{2,6}\d{8,15}\b'
    for match in re.finditer(acct_pattern, text):
        val = match.group(0)
        
        if not any(e['value'] == val for e in entities):
            entities.append({"type": "BANK_ACCOUNT", "value": val, "start": match.start(), "end": match.end()})

    case_ids = []
    case_id_pattern = r'FIR NO:\s*([\w\-]+)'
    for match in re.finditer(case_id_pattern, text):
        case_ids.append(match.group(1).strip())

    return entities, case_ids

def extract_bert_entities(text: str):
    """Run BERT NER only on the narrative body, then remap offsets."""
    if not ner_pipeline:
        return []

    narrative, offset = _extract_narrative_only(text)

    try:
        results = ner_pipeline(narrative)
    except Exception as e:
        print(f"BERT NER failed: {e}")
        return []

    entities = []
    seen_values = set()

    for res in results:
        val = res['word'].strip()

        if val.startswith('##'):
            continue
        
        if len(val) < 3:
            continue
        
        if re.fullmatch(r'[\d\s\W]+', val):
            continue
        
        ent_type = res['entity_group']
        if ent_type == 'MISC':
            continue
        
        if val in seen_values:
            continue
        seen_values.add(val)

        if ent_type == 'PER':
            ent_type = 'PERSON'
        elif ent_type == 'ORG':
            ent_type = 'ORGANIZATION'
        elif ent_type == 'LOC':
            ent_type = 'LOCATION'

        start = res['start'] + offset
        end = res['end'] + offset

        entities.append({
            "type": ent_type,
            "value": val,
            "start": start,
            "end": end
        })

    return entities

from .linker import nlp as spacy_nlp

def extract_spacy_entities(text: str):
    if not spacy_nlp:
        return []
        
    narrative, offset = _extract_narrative_only(text)
    doc = spacy_nlp(narrative)
    
    entities = []
    label_map = {"PERSON": "PERSON", "ORG": "ORGANIZATION", "GPE": "LOCATION", "LOC": "LOCATION"}
    
    for ent in doc.ents:
        if ent.label_ in label_map and len(ent.text.strip()) >= 3:
            entities.append({
                "type": label_map[ent.label_],
                "value": ent.text.strip(),
                "start": offset + ent.start_char,
                "end": offset + ent.end_char
            })
    return entities

def extract_all(text: str):
    regex_ents, case_ids = extract_regex_entities(text)
    bert_ents = extract_bert_entities(text)
    spacy_ents = extract_spacy_entities(text)

    regex_spans = set((e['start'], e['end']) for e in regex_ents)
    filtered_bert = [e for e in bert_ents if (e['start'], e['end']) not in regex_spans]
    
    all_ents = regex_ents + filtered_bert

    existing_vals = set([e['value'].lower() for e in all_ents])
    for e in spacy_ents:
        if e['value'].lower() not in existing_vals:
            
            overlap = False
            for ae in all_ents:
                if max(e['start'], ae['start']) < min(e['end'], ae['end']):
                    overlap = True
                    break
            if not overlap:
                all_ents.append(e)
                existing_vals.add(e['value'].lower())

    return all_ents, case_ids

def extract_regex_only(text: str):
    """Fast regex-only extraction — no BERT, no PyTorch GIL. Safe for background threads."""
    ents, case_ids = extract_regex_entities(text)
    return ents, case_ids

