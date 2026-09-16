-- I due stati finali non parlano più di approvazione ma di idoneità al dataset:
-- REVIEWED = documento annotato, tipo e campi a database, entra nei test futuri;
-- DISCARDED = documento da tenere fuori. La coda NEEDS_REVIEW resta com'era.
UPDATE documents SET status = 'REVIEWED' WHERE status = 'APPROVED';
UPDATE documents SET status = 'DISCARDED' WHERE status = 'REJECTED';
