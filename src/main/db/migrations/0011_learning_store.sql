-- Dove il motore tiene quello che impara dalle revisioni.
--
-- Il registry resta la base immutabile, come per la mappa dei campi (0008): quello che si
-- impara sta qui e si somma alla base in lettura. Questa migrazione apre solo il deposito;
-- nessuna regola cambia ancora l'estrazione.
--
-- Il modello è `document_type_feedback` di pratica-ai, dove il reviewer un giorno finirà:
-- il feedback non si aggiorna e non si cancella, si lega ai byte del documento e non alla
-- riga del documento, e dice sempre chi l'ha dato.

-- La modalità del learner, una riga sola.
--   LEARNING  registra le revisioni, aggiorna le regole, applica quelle attive.
--   FROZEN    applica le regole già attive, ma non registra e non cambia niente.
--   BASELINE  solo registry: nessuna regola applicata, niente registrato. Per i benchmark e
--             per annotare un holdout senza contaminarlo.
CREATE TABLE learning_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  mode       TEXT NOT NULL CHECK (mode IN ('LEARNING', 'FROZEN', 'BASELINE')),
  updated_at TEXT NOT NULL
);
INSERT INTO learning_state (id, mode, updated_at)
  VALUES (1, 'LEARNING', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Il registro di quello che il revisore ha deciso chiudendo un documento: un evento per il
-- tipo e uno per ogni campo o riga toccati o confermati. Append-only.
--
-- Nessuna foreign key verso documents: il documento può essere cancellato, il fatto che il
-- revisore l'abbia deciso resta. `content_sha256` è la chiave che sopravvive al documento
-- (NULL solo per documenti elaborati prima della 0010).
--
-- Nessun valore e nessun testo del documento: la posizione della selezione sì, perché è da
-- lì che si ricava l'etichetta; i valori stanno nei campi, e un registro che non si
-- cancella non deve portarsi dietro dati personali.
CREATE TABLE learning_events (
  id                   TEXT PRIMARY KEY,
  -- Il momento della revisione: gli eventi di una stessa chiusura lo condividono.
  at                   TEXT NOT NULL,
  -- Chi ha deciso. Mai NULL: un esempio senza autore non lo sottoscrive nessuno.
  actor                TEXT NOT NULL,
  document_id          TEXT NOT NULL,
  content_sha256       TEXT,
  template_fingerprint TEXT,
  text_source          TEXT,
  -- DOCUMENT_TYPE | FIELD_VALUE
  kind                 TEXT NOT NULL,
  -- CONFIRMED | CHANGED | FILLED | CLEARED | ADDED | REMOVED, come le correzioni del dataset.
  outcome              TEXT NOT NULL,
  -- Il tipo con cui il documento è stato chiuso, e quello che il classificatore aveva proposto.
  document_type        TEXT,
  predicted_type       TEXT,
  predicted_confidence REAL,
  field_id             TEXT,
  item_index           INTEGER,
  -- La confidence del valore proposto dal motore, NULL se non ne aveva proposto uno.
  engine_confidence    REAL,
  -- Da dove il revisore ha preso il valore, se l'ha selezionato: come le evidenze REVIEWER.
  pick_method          TEXT,
  pick_page            INTEGER,
  pick_bbox_json       TEXT,
  pick_line_start      INTEGER,
  pick_line_end        INTEGER,
  pick_char_start      INTEGER,
  pick_char_end        INTEGER,
  learner_version      TEXT NOT NULL
);
CREATE INDEX learning_events_at ON learning_events (at DESC);
CREATE INDEX learning_events_document ON learning_events (document_id, at);
CREATE INDEX learning_events_field ON learning_events (document_type, field_id, at);

-- Le regole: una riga per regola distinta, individuata da `rule_key`. Una regola non si
-- cancella: finisce REJECTED, e la cronologia dice perché.
--
-- Supporto e precisione non si salvano: sono positive_count e
-- positive_count / (positive_count + negative_count), e una colonna in più potrebbe solo
-- divergere dai contatori.
CREATE TABLE learning_rules (
  id                   TEXT PRIMARY KEY,
  -- EXTRACTION_ANCHOR | TEMPLATE_TYPE | CLASSIFIER_POSITIVE | CLASSIFIER_NEGATIVE
  kind                 TEXT NOT NULL,
  scope                TEXT NOT NULL CHECK (scope IN ('TEMPLATE', 'CLASS')),
  -- Tipo, campo e impronta a cui la regola si applica; l'impronta solo per scope TEMPLATE.
  document_type        TEXT NOT NULL,
  field_id             TEXT,
  template_fingerprint TEXT,
  -- La forma della regola, che dipende dal tipo: per un'etichetta { label, relation, reader }.
  pattern_json         TEXT NOT NULL,
  -- Tipo, ambito e forma normalizzati: la stessa regola imparata due volte è una riga sola.
  rule_key             TEXT NOT NULL UNIQUE,
  status               TEXT NOT NULL
                         CHECK (status IN ('CANDIDATE', 'ACTIVE', 'SUSPENDED', 'REJECTED')),
  positive_count       INTEGER NOT NULL DEFAULT 0,
  negative_count       INTEGER NOT NULL DEFAULT 0,
  last_positive_at     TEXT,
  last_negative_at     TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  learner_version      TEXT NOT NULL
);
CREATE INDEX learning_rules_lookup ON learning_rules (status, kind, document_type);
CREATE INDEX learning_rules_template ON learning_rules (template_fingerprint, status);

-- Quali eventi sostengono o smentiscono una regola. Un evento conta una volta per regola.
CREATE TABLE learning_rule_evidence (
  rule_id  TEXT NOT NULL REFERENCES learning_rules (id),
  event_id TEXT NOT NULL REFERENCES learning_events (id),
  effect   TEXT NOT NULL CHECK (effect IN ('POSITIVE', 'NEGATIVE')),
  PRIMARY KEY (rule_id, event_id)
) WITHOUT ROWID;
CREATE INDEX learning_rule_evidence_event ON learning_rule_evidence (event_id);

-- La cronologia delle decisioni del learner e di chi lo governa: cambi di modalità e di
-- stato delle regole. Le regole candidate nascono senza una riga qui, altrimenti ogni
-- revisione ne scriverebbe decine; quello che conta è quando una regola comincia o smette
-- di valere. Come profile_actions, non si aggiorna e non si cancella: annullare è una riga.
CREATE TABLE learning_actions (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  -- MODE_CHANGED | RULE_PROMOTED | RULE_SUSPENDED | RULE_REACTIVATED | RULE_REJECTED | REVERT
  kind         TEXT NOT NULL,
  rule_id      TEXT REFERENCES learning_rules (id),
  -- Modalità o stato della regola, prima e dopo.
  before_state TEXT,
  after_state  TEXT,
  detail       TEXT NOT NULL,
  -- Supporto e precisione al momento dell'azione, come JSON.
  numbers_json TEXT,
  reverts_id   TEXT REFERENCES learning_actions (id),
  reverted_at  TEXT
);
CREATE INDEX learning_actions_at ON learning_actions (at DESC);
CREATE INDEX learning_actions_rule ON learning_actions (rule_id, at DESC);
