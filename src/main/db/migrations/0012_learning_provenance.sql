-- Da quale regola appresa viene un valore, e una prova per documento.
--
-- Una regola si mette alla prova sui documenti che ha precompilato: confermato il valore,
-- ci ha preso; corretto, no. Per saperlo l'evidenza del motore dice quale regola l'ha letta,
-- e l'evento della revisione se lo porta dietro.

-- La regola che ha trovato l'etichetta; NULL per le etichette del registry.
ALTER TABLE evidence ADD COLUMN rule_id TEXT REFERENCES learning_rules (id);

-- La regola dietro la proposta del motore al momento della revisione.
ALTER TABLE learning_events ADD COLUMN engine_rule_id TEXT REFERENCES learning_rules (id);

-- Una prova per documento, non per evento. Richiudere un documento registra di nuovo i suoi
-- eventi, e un documento salvato due volte non deve valere doppio: la prova nuova prende il
-- posto della vecchia. `document_key` è lo sha-256 del file, o l'id del documento quando
-- l'hash manca.
--
-- La tabella si ricrea invece di aggiungere una colonna: nessuna versione l'ha mai scritta
-- (la 0011 l'ha aperta, la registrazione delle revisioni non ci scrive), quindi è vuota, e
-- la chiave primaria cambia.
DROP TABLE learning_rule_evidence;
CREATE TABLE learning_rule_evidence (
  rule_id      TEXT NOT NULL REFERENCES learning_rules (id),
  document_key TEXT NOT NULL,
  event_id     TEXT NOT NULL REFERENCES learning_events (id),
  effect       TEXT NOT NULL CHECK (effect IN ('POSITIVE', 'NEGATIVE')),
  PRIMARY KEY (rule_id, document_key)
) WITHOUT ROWID;
CREATE INDEX learning_rule_evidence_document ON learning_rule_evidence (document_key);
CREATE INDEX learning_rule_evidence_event ON learning_rule_evidence (event_id);
