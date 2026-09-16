-- Review workspace v2.

-- Esito del classificatore sull'ultima elaborazione: candidati col punteggio e le frasi
-- del documento che li suggeriscono. Serve alla scheda tipo per proporre i candidati
-- quando il tipo resta UNKNOWN, e all'export per sapere cosa aveva proposto il motore
-- quando il revisore ha scelto un altro tipo. NULL = documento elaborato prima di questa
-- versione: la rielaborazione in sottofondo lo riempie.
ALTER TABLE documents ADD COLUMN classification_json TEXT;

-- Quando il revisore ha chiuso il documento (Salva o Scarta). Solo informativo.
ALTER TABLE documents ADD COLUMN reviewed_at TEXT;

-- Righe dei campi ripetuti: ENGINE = proposta dal motore, MANUAL = aggiunta dal revisore.
-- `removed` toglie una riga proposta senza cancellarla: la proposta resta per il
-- before/after e una nuova estrazione non la rimette in lista.
ALTER TABLE field_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'ENGINE';
ALTER TABLE field_items ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;

-- Una correzione sopravvissuta a un run che non ha più trovato la sua riga (valore
-- precompilato assente) è di fatto una riga messa dal revisore.
UPDATE field_items SET origin = 'MANUAL' WHERE value_json IS NULL AND corrected_value_json IS NOT NULL;
