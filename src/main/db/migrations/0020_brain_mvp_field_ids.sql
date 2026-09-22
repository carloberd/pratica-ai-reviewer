-- I campi che il Brain MVP ha spaccato o rinominato, portati sui nuovi id.
--
-- Il registry del 22/09 non ha più `issuer.tax_id`, `recipient.tax_id`, `company.tax_id`
-- né `company.registration_number`: al loro posto ci sono campi distinti per partita IVA,
-- codice fiscale e numero REA. Sui documenti d'identità le chiavi `identity.*` hanno
-- lasciato il posto a quelle generiche, già dal pilota di settembre.
--
-- Senza questa migrazione le righe scritte prima resterebbero con un nome che l'ontologia
-- non conosce: il revisore le vedrebbe fuori mappa e ogni correzione fatta finora
-- andrebbe rifatta a mano.
--
-- Dove un `*.tax_id` poteva essere l'una o l'altra cosa — l'etichetta diceva «CF/P.IVA» —
-- la riga va sul codice fiscale: è la lettura larga, e su un valore di undici cifre il
-- revisore lo sposta con un clic. Indovinare dal valore sarebbe peggio di sbagliare in
-- modo prevedibile.
--
-- Il `NOT EXISTS` è lo stesso della 0004: se il documento ha già una riga col nome nuovo
-- — perché è stato rielaborato dopo l'aggiornamento — la vecchia resta dov'è invece di
-- creare un doppione che violerebbe l'unicità.

UPDATE fields SET name = 'issuer.tax_code', label = 'Codice fiscale emittente' WHERE name = 'issuer.tax_id' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'issuer.tax_code');
UPDATE fields SET name = 'recipient.tax_code', label = 'Codice fiscale destinatario' WHERE name = 'recipient.tax_id' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'recipient.tax_code');
UPDATE fields SET name = 'company.tax_code', label = 'Codice fiscale impresa' WHERE name = 'company.tax_id' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'company.tax_code');
UPDATE fields SET name = 'company.rea_number', label = 'Numero REA' WHERE name = 'company.registration_number' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'company.rea_number');
UPDATE fields SET name = 'document.number', label = 'Numero documento' WHERE name = 'identity.document_number' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'document.number');
UPDATE fields SET name = 'document.issue_date', label = 'Data emissione' WHERE name = 'identity.issue_date' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'document.issue_date');
UPDATE fields SET name = 'document.expiry_date', label = 'Data scadenza' WHERE name = 'identity.expiry_date' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'document.expiry_date');
