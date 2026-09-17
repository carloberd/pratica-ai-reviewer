-- Da dove il revisore ha preso un valore, e il testo su cui ritrovarlo.
--
-- Fino alla 0009 selezionare un valore sul documento lasciava solo il valore: pagina,
-- riquadro e riga si perdevano nel renderer. Sono il segnale da cui il motore può imparare
-- quale etichetta annuncia un campo, quindi da qui restano.

-- Le evidenze non sono più solo del motore. Una REVIEWER è la selezione del revisore:
-- sopravvive alla rielaborazione, che sostituisce solo le ENGINE, e segue la correzione a
-- cui appartiene.
ALTER TABLE evidence ADD COLUMN origin TEXT NOT NULL DEFAULT 'ENGINE'
  CHECK (origin IN ('ENGINE', 'REVIEWER'));
-- TEXT_SELECTION | AREA_OCR, solo per le evidenze del revisore.
ALTER TABLE evidence ADD COLUMN method TEXT;
-- Dove cade la selezione fra le righe di document_pages: indici delle righe (0-based) e
-- offset nel testo della pagina, cioè le righe unite da «\n». NULL quando non si ritrova
-- con certezza: una posizione indovinata insegnerebbe un'etichetta sbagliata.
ALTER TABLE evidence ADD COLUMN line_start INTEGER;
ALTER TABLE evidence ADD COLUMN line_end INTEGER;
ALTER TABLE evidence ADD COLUMN char_start INTEGER;
ALTER TABLE evidence ADD COLUMN char_end INTEGER;

-- La selezione da cui viene la correzione. Accanto a evidence_id, che resta l'evidenza
-- della proposta del motore: il before/after ha bisogno di entrambe.
ALTER TABLE fields ADD COLUMN corrected_evidence_id TEXT REFERENCES evidence(id);
ALTER TABLE field_items ADD COLUMN corrected_evidence_id TEXT REFERENCES evidence(id);

-- Lo sha-256 del file elaborato: la chiave su cui un dataset esterno (pratica-ai indicizza
-- il feedback sull'hash dei byte) ritrova lo stesso documento. NULL = non ancora elaborato
-- con questa versione.
ALTER TABLE documents ADD COLUMN content_sha256 TEXT;

-- Le righe del testo come le ha lette l'elaborazione, con le coordinate quando ci sono.
-- Sono le stesse righe del motore di estrazione: una selezione si ritrova qui, e non nel
-- text layer del renderer, perché è su queste righe che una regola verrà applicata.
-- Dato derivato: si sostituisce a ogni elaborazione e se ne va col documento.
CREATE TABLE document_pages (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page        INTEGER NOT NULL,
  -- NATIVE_TEXT | OCR | DOCX: da dove viene il testo di questa pagina.
  text_source TEXT NOT NULL,
  -- [{ "text": "...", "bbox": { "x", "y", "w", "h" } }], bbox assente senza coordinate.
  lines_json  TEXT NOT NULL,
  PRIMARY KEY (document_id, page)
) WITHOUT ROWID;
