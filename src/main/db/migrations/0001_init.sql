-- Schema v1 di praticaai-reviewer.
-- I PDF restano file nella cache su disco: nel database finiscono solo i path, mai BLOB.

CREATE TABLE documents (
  id TEXT PRIMARY KEY,                  -- crypto.randomUUID()
  drive_file_id TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,                   -- application/pdf | mime docx
  document_type TEXT,                   -- chiave registry 'famiglia.tipo' o slug manuale
  type_confidence REAL,
  confidence REAL,                      -- media dei campi
  confidence_band TEXT,                 -- HIGH | MEDIUM | LOW
  status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
  cached_path TEXT,                     -- copia locale in cache
  text_source TEXT,                     -- NATIVE_TEXT | OCR | DOCX
  received_at TEXT,                     -- modifiedTime Drive
  synced_at TEXT NOT NULL
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  text TEXT NOT NULL,                   -- verbatim dal documento
  bbox_json TEXT,                       -- {x,y,w,h} in coordinate pagina pdf.js, nullable
  confidence REAL NOT NULL
);

CREATE TABLE fields (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                   -- campo del registry
  label TEXT NOT NULL,                  -- etichetta UI italiana
  value TEXT,                           -- valore precompilato
  corrected_value TEXT,                 -- correzione umana (CORRECT)
  confidence REAL NOT NULL,
  evidence_id TEXT REFERENCES evidence(id),
  updated_at TEXT
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  bbox_json TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- highlight | note
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (                   -- timeline della UI
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  document_id UNINDEXED, filename, page, page_text
);

-- La tabella FTS non ha vincoli di integrità: le righe orfane vanno rimosse a mano
-- quando un documento sparisce.
CREATE TRIGGER documents_fts_cleanup AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE document_id = old.id;
END;

CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_type ON documents(document_type);
CREATE INDEX idx_documents_band ON documents(confidence_band);
CREATE INDEX idx_documents_received ON documents(received_at DESC);
CREATE INDEX idx_fields_document ON fields(document_id);
CREATE INDEX idx_fields_evidence ON fields(evidence_id);
CREATE INDEX idx_evidence_document ON evidence(document_id);
CREATE INDEX idx_annotations_document ON annotations(document_id, page);
CREATE INDEX idx_events_document ON events(document_id, at);
