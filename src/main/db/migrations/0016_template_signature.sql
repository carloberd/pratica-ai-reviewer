-- La firma normalizzata della testata, accanto all'impronta esatta.
--
-- L'impronta della 0013 è una chiave: due documenti la condividono o no. Sui documenti
-- misurati finora quasi sempre no — ogni impronta valeva per un documento solo. Con
-- `minTemplateSupport` a 2 e `minTemplateTypeSupport` a 3, questo vuol dire che nessuna
-- regola di scope TEMPLATE può attivarsi: lo scope più preciso del learner resta
-- candidato per sempre.
--
-- La firma tiene anche l'insieme delle ancore da cui la chiave è ricavata, così due
-- testate si confrontano per quante ne hanno in comune invece che per uguaglianza. Le
-- ancore sono hashate una per una: niente testo e niente valori, come l'impronta.
--
-- `template_fingerprint` resta dov'è e non viene toccata. Le regole scritte prima di qui
-- non hanno firma e continuano a valere per confronto esatto; gli eventi storici restano
-- con la colonna a NULL, che è esattamente quello che erano.

ALTER TABLE documents ADD COLUMN template_signature_json TEXT;
ALTER TABLE learning_events ADD COLUMN template_signature_json TEXT;
