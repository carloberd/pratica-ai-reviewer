-- Impronta del layout della prima pagina: stesso stampato con dati diversi -> stessa
-- impronta. Serve all'export XLSX per riconoscere i documenti usciti dallo stesso
-- modulo senza confrontarne i valori.
--
-- Il layout di un documento non cambia: l'impronta si calcola una volta sola, al primo
-- export che incontra il documento, e resta. NULL = non ancora calcolata, oppure copia
-- locale non più in cache (il documento non si riscarica per un export).
ALTER TABLE documents ADD COLUMN template_fingerprint TEXT;
