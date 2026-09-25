import jellyfish
import spacy

try:
    nlp = spacy.load("en_core_web_sm")
except OSError:
    print("en_core_web_sm not found, please install it.")
    nlp = None

def resolve_entities(entities):
    """
    Applies Double Metaphone phonetic encoding and Jaro-Winkler string distance (>0.85)
    to find potential aliases among PERSON entities.
    """
    aliases = []
    persons = [e for e in entities if e['type'] == 'PERSON']

    unique_persons = []
    seen_vals = set()
    for p in persons:
        if p['value'] not in seen_vals:
            unique_persons.append(p)
            seen_vals.add(p['value'])
            
    for i in range(len(unique_persons)):
        for j in range(i+1, len(unique_persons)):
            val1 = unique_persons[i]['value']
            val2 = unique_persons[j]['value']

            dm1 = jellyfish.metaphone(val1)
            dm2 = jellyfish.metaphone(val2)

            jw_score = jellyfish.jaro_winkler_similarity(val1, val2)
            
            if dm1 == dm2 or jw_score > 0.85:
                aliases.append({
                    "source": unique_persons[i],
                    "target": unique_persons[j],
                    "type": "ALIAS_OF"
                })
                
    return aliases

def extract_relationships(text: str, entities: list, case_id: str):
    """
    Extract relationships and enforce Anti-Floating Node logic.
    """
    if not nlp:
        relationships = []
        for e in entities:
             relationships.append({
                "source": e,
                "target": {"type": "CASE", "value": case_id},
                "type": "MENTIONED_IN"
            })
        return relationships, []

    doc = nlp(text)
    relationships = []
    
    ent_spans = sorted(entities, key=lambda x: x['start'])
    
    for sent in doc.sents:
        sent_ents = [e for e in ent_spans if e['start'] >= sent.start_char and e['end'] <= sent.end_char]
        
        verbs = [token.lemma_.lower() for token in sent if token.pos_ == 'VERB']
        nouns = [token.lemma_.lower() for token in sent if token.pos_ in ('NOUN', 'PROPN')]
        
        verb_name = "ASSOCIATE"
        if 'call' in verbs or 'contact' in verbs or 'phone' in verbs:
            verb_name = "CALLED"
        elif 'transfer' in verbs or 'pay' in verbs or 'transact' in verbs or 'send' in verbs or 'receive' in verbs:
            verb_name = "TRANSACTED_TO"
        elif 'arrest' in verbs or 'accuse' in verbs or 'capture' in verbs:
            verb_name = "CO_ACCUSED"
        elif 'boss' in nouns or 'manager' in nouns or 'leader' in nouns or 'head' in nouns:
            verb_name = "WORKS_FOR"
            
        if len(sent_ents) >= 2:
            for i in range(len(sent_ents)):
                for j in range(i + 1, len(sent_ents)):
                    e1 = sent_ents[i]
                    e2 = sent_ents[j]
                    
                    if e1['type'] != 'PERSON' and e2['type'] == 'PERSON':
                        e1, e2 = e2, e1
                        
                    rel_type = verb_name
                    
                    if e1['type'] == 'PERSON' and e2['type'] == 'PHONE':
                        rel_type = "USES_COMMUNICATION"
                    elif e1['type'] == 'PERSON' and e2['type'] == 'BANK_ACCOUNT':
                        rel_type = "OWNS_ACCOUNT"
                    elif e1['type'] == 'PERSON' and e2['type'] == 'VEHICLE':
                        rel_type = "OWNS_VEHICLE"
                    elif (e1['type'] == 'PHONE' and e2['type'] == 'PHONE') or 'call' in verbs:
                        rel_type = "CALLED"
                    elif (e1['type'] == 'BANK_ACCOUNT' and e2['type'] == 'BANK_ACCOUNT') or 'transfer' in verbs:
                        rel_type = "TRANSACTED_TO"
                    elif e1['type'] == 'PERSON' and e2['type'] == 'PERSON':
                        rel_type = verb_name
                    else:
                        rel_type = "ASSOCIATE"

                    relationships.append({
                        "source": e1,
                        "target": e2,
                        "type": rel_type,
                        "explanation": f'"{sent.text.strip()}"'
                    })
                    e1['has_edge'] = True
                    e2['has_edge'] = True

    for e in entities:
        if not e.get('has_edge'):
            
            relationships.append({
                "source": e,
                "target": {"type": "CASE", "value": case_id},
                "type": "MENTIONED_IN"
            })
            
    aliases = resolve_entities(entities)
    
    return relationships, aliases
