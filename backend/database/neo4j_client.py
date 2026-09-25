from neo4j import GraphDatabase

class Neo4jClient:
    def __init__(self, uri="bolt://localhost:7687", user="neo4j", password="password"):
        self.driver = GraphDatabase.driver(
            uri,
            auth=(user, password),
            connection_timeout=2,       
            max_transaction_retry_time=2 
        )
        
    def close(self):
        self.driver.close()
        
    def ingest_data(self, entities, relationships, aliases, case_id):
        try:
            with self.driver.session() as session:
                
                session.execute_write(self._create_case_node, case_id)

                for ent in entities:
                    session.execute_write(self._merge_entity, ent, case_id)

                for rel in relationships:
                    session.execute_write(self._create_relationship, rel)

                for alias in aliases:
                    session.execute_write(self._create_relationship, alias)
        except Exception as e:
            print(f"Neo4j ingest failed (Neo4j may be offline): {e}. Data stored locally only.")

    @staticmethod
    def _create_case_node(tx, case_id):
        query = """
        MERGE (c:CASE {id: $case_id})
        ON CREATE SET c.status = 'Active'
        """
        tx.run(query, case_id=case_id)
        
    @staticmethod
    def _merge_entity(tx, entity, case_id):

        query = f"""
        MERGE (n:{entity['type']} {{id: $value}})
        ON CREATE SET n.case_ids = [$case_id], n.label = $value
        ON MATCH SET n.case_ids = 
            CASE WHEN NOT $case_id IN n.case_ids THEN n.case_ids + [$case_id] ELSE n.case_ids END
        """
        tx.run(query, value=entity['value'], case_id=case_id)
        
    @staticmethod
    def _create_relationship(tx, rel):
        src = rel['source']
        tgt = rel['target']
        rel_type = rel['type']
        
        query = f"""
        MATCH (a:{src['type']} {{id: $src_val}})
        MATCH (b:{tgt['type']} {{id: $tgt_val}})
        MERGE (a)-[r:{rel_type}]->(b)
        ON CREATE SET r.explanation = $explanation
        ON MATCH SET r.explanation = $explanation
        """
        tx.run(query, src_val=src['value'], tgt_val=tgt['value'], explanation=rel.get('explanation', ''))
        
    def run_gds_analytics(self):
        with self.driver.session() as session:
            
            try:
                session.run("CALL gds.graph.drop('caseGraph', false) YIELD graphName")
                session.run("CALL gds.graph.project('caseGraph', '*', '*') YIELD graphName")
                session.run("CALL gds.pageRank.write('caseGraph', {writeProperty: 'pageRank'}) YIELD nodePropertiesWritten")
                session.run("CALL gds.betweenness.write('caseGraph', {writeProperty: 'betweenness'}) YIELD nodePropertiesWritten")
            except Exception as e:
                print(f"GDS Analytics failed (ensure GDS plugin is installed): {e}")

    def get_graph_data(self):
        try:
            with self.driver.session() as session:
                nodes_query = "MATCH (n) RETURN id(n) as id, labels(n)[0] as type, n.id as value, n.case_ids as case_ids, n.pageRank as pageRank, n.betweenness as betweenness"
                edges_query = "MATCH (a)-[r]->(b) RETURN id(a) as source, id(b) as target, type(r) as type"
                
                nodes_res = session.run(nodes_query)
                edges_res = session.run(edges_query)
                
                nodes = [{"data": {"id": str(r["id"]), "type": r["type"], "label": r["value"], "case_ids": r["case_ids"], "pageRank": r.get("pageRank", 0), "betweenness": r.get("betweenness", 0)}} for r in nodes_res]
                edges = [{"data": {"source": str(r["source"]), "target": str(r["target"]), "type": r["type"]}} for r in edges_res]
                
                return {"nodes": nodes, "edges": edges}
        except Exception as e:
            print(f"Neo4j connection failed: {e}. Returning mock data for demonstration.")
            
            return {
                "nodes": [
                    {"data": {"id": "c1", "type": "CASE", "label": "FIR-2026-DEL-0101", "case_ids": ["FIR-2026-DEL-0101"]}},
                    {"data": {"id": "c2", "type": "CASE", "label": "FIR-2026-DEL-0205", "case_ids": ["FIR-2026-DEL-0205"]}},
                    {"data": {"id": "c3", "type": "CASE", "label": "FIR-2026-MUM-901", "case_ids": ["FIR-2026-MUM-901"]}},
                    {"data": {"id": "c4", "type": "CASE", "label": "FIR-2026-BLR-404", "case_ids": ["FIR-2026-BLR-404"]}},
                    {"data": {"id": "c5", "type": "CASE", "label": "FIR-2026-CHE-777", "case_ids": ["FIR-2026-CHE-777"]}},
                    
                    {"data": {"id": "n1", "type": "PERSON", "label": "Aarnav Kandda", "case_ids": ["FIR-2026-DEL-0101"], "pageRank": 0.2, "betweenness": 60, "geo_lat": 28.6139, "geo_long": 77.2090}},
                    {"data": {"id": "n2", "type": "PERSON", "label": "Rajesh Kumar", "case_ids": ["FIR-2026-DEL-0101", "FIR-2026-DEL-0205"], "pageRank": 0.05, "betweenness": 20, "geo_lat": 28.6239, "geo_long": 77.2190}},
                    {"data": {"id": "n3", "type": "PERSON", "label": "Vikas Sharma", "case_ids": ["FIR-2026-MUM-901"], "pageRank": 0.1, "betweenness": 30}},
                    {"data": {"id": "n4", "type": "PERSON", "label": "Karthik Reddy", "case_ids": ["FIR-2026-BLR-404"], "pageRank": 0.08, "betweenness": 15}},
                    {"data": {"id": "n5", "type": "PERSON", "label": "Charan Hari", "case_ids": ["FIR-2026-CHE-777"], "pageRank": 0.25, "betweenness": 80}},
                    {"data": {"id": "n6", "type": "PERSON", "label": "Ramesh", "case_ids": ["FIR-2026-CHE-777"], "pageRank": 0.02, "betweenness": 5}},
                    
                    {"data": {"id": "p1", "type": "PHONE", "label": "9876543210", "case_ids": ["FIR-2026-DEL-0101", "FIR-2026-DEL-0205", "FIR-2026-BLR-404"]}},
                    {"data": {"id": "a1", "type": "BANK_ACCOUNT", "label": "HDFC0001234", "case_ids": ["FIR-2026-DEL-0101", "FIR-2026-MUM-901"]}},
                    {"data": {"id": "l1", "type": "LOCATION", "label": "Delhi Connaught Place", "case_ids": ["FIR-2026-DEL-0101"]}}
                ],
                "edges": [
                    {"data": {"source": "n1", "target": "c1", "type": "MENTIONED_IN"}},
                    {"data": {"source": "n2", "target": "c1", "type": "MENTIONED_IN"}},
                    {"data": {"source": "n2", "target": "c2", "type": "MENTIONED_IN"}},
                    {"data": {"source": "n3", "target": "c3", "type": "MENTIONED_IN"}},
                    {"data": {"source": "n4", "target": "c4", "type": "MENTIONED_IN"}},
                    {"data": {"source": "n5", "target": "c5", "type": "MENTIONED_IN"}},
                    {"data": {"source": "n6", "target": "c5", "type": "MENTIONED_IN"}},
                    
                    {"data": {"source": "n1", "target": "n2", "type": "CALLED"}},
                    {"data": {"source": "n6", "target": "n5", "type": "HIRED_BY"}},
                    
                    {"data": {"source": "n1", "target": "p1", "type": "OWNS"}},
                    {"data": {"source": "n2", "target": "p1", "type": "OWNS"}},
                    {"data": {"source": "n4", "target": "p1", "type": "RECEIVED_INSTRUCTIONS_ON"}},
                    
                    {"data": {"source": "n1", "target": "a1", "type": "TRANSACTED_TO"}},
                    {"data": {"source": "n3", "target": "a1", "type": "TRANSFERRED_FUNDS_TO"}},
                    
                    {"data": {"source": "n1", "target": "l1", "type": "LOCATED_AT"}}
                ]
            }

    def clear_db(self):
        with self.driver.session() as session:
            session.run("MATCH (n) DETACH DELETE n")
