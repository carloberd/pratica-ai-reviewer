-- Le annotazioni sul PDF sono state rimosse dal prodotto: la revisione lavora sui
-- campi estratti e sulle evidenze, che il main ricava dal documento. La tabella
-- resterebbe solo a raccogliere righe che nessuna schermata sa più mostrare.
DROP INDEX IF EXISTS idx_annotations_document;
DROP TABLE IF EXISTS annotations;
