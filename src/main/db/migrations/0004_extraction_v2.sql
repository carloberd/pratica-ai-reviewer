-- Extraction Brain v2 migration.
-- Backward-compatible with the v1 scalar fields table.

ALTER TABLE fields ADD COLUMN semantic_type TEXT;
ALTER TABLE fields ADD COLUMN cardinality TEXT NOT NULL DEFAULT 'one';
ALTER TABLE fields ADD COLUMN review_status TEXT;
ALTER TABLE fields ADD COLUMN validation_errors_json TEXT;
ALTER TABLE fields ADD COLUMN role TEXT;

CREATE TABLE IF NOT EXISTS field_items (
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  value_json TEXT,
  corrected_value_json TEXT,
  confidence REAL NOT NULL,
  evidence_id TEXT REFERENCES evidence(id),
  validation_errors_json TEXT,
  updated_at TEXT,
  UNIQUE(field_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_field_items_field ON field_items(field_id);

CREATE TABLE IF NOT EXISTS extraction_runs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  engine_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  document_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  missing_required_json TEXT,
  conflicts_json TEXT,
  metrics_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_document ON extraction_runs(document_id, started_at DESC);

-- Nomi campo v1 -> id dell'ontologia v2, generati da resources/registry/v2/legacy_field_map_v2.json
-- (il test della migrazione verifica che restino allineati). Senza questo passo le
-- correzioni già salvate andrebbero perse: `fields.replaceForDocument` le conserva per
-- nome, e dopo la migrazione il motore v2 scrive solo i nomi nuovi.
-- `amount` e `customs_value` finiscono entrambi su `money.amount`: nessuno schema v1 li
-- dichiara insieme, ma la guardia NOT EXISTS evita comunque due righe con lo stesso nome.
UPDATE fields SET name = 'document.number', label = 'Numero documento' WHERE name = 'document_number' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'document.number');
UPDATE fields SET name = 'document.issue_date', label = 'Data emissione' WHERE name = 'issue_date' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'document.issue_date');
UPDATE fields SET name = 'issuer.name', label = 'Emittente' WHERE name = 'issuer_name' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'issuer.name');
UPDATE fields SET name = 'recipient.name', label = 'Destinatario' WHERE name = 'recipient_name' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'recipient.name');
UPDATE fields SET name = 'money.taxable', label = 'Imponibile' WHERE name = 'taxable_amount' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'money.taxable');
UPDATE fields SET name = 'money.tax', label = 'Imposta/IVA' WHERE name = 'tax_amount' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'money.tax');
UPDATE fields SET name = 'money.total', label = 'Totale' WHERE name = 'total_amount' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'money.total');
UPDATE fields SET name = 'money.currency', label = 'Valuta' WHERE name = 'currency' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'money.currency');
UPDATE fields SET name = 'money.amount', label = 'Importo' WHERE name = 'amount' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'money.amount');
UPDATE fields SET name = 'insurance.premium', label = 'Premio' WHERE name = 'premium_amount' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'insurance.premium');
UPDATE fields SET name = 'payment.date', label = 'Data pagamento' WHERE name = 'payment_date' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'payment.date');
UPDATE fields SET name = 'finance.transaction_date', label = 'Data operazione' WHERE name = 'transaction_date' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'finance.transaction_date');
UPDATE fields SET name = 'document.effective_date', label = 'Data decorrenza' WHERE name = 'effective_date' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'document.effective_date');
UPDATE fields SET name = 'document.declaration_date', label = 'Data dichiarazione' WHERE name = 'declaration_date' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'document.declaration_date');
UPDATE fields SET name = 'logistics.shipment_date', label = 'Data spedizione' WHERE name = 'shipment_date' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'logistics.shipment_date');
UPDATE fields SET name = 'insurance.coverage_start', label = 'Inizio copertura' WHERE name = 'coverage_start' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'insurance.coverage_start');
UPDATE fields SET name = 'insurance.coverage_end', label = 'Fine copertura' WHERE name = 'coverage_end' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'insurance.coverage_end');
UPDATE fields SET name = 'utility.period_start', label = 'Inizio periodo' WHERE name = 'period_start' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'utility.period_start');
UPDATE fields SET name = 'utility.period_end', label = 'Fine periodo' WHERE name = 'period_end' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'utility.period_end');
UPDATE fields SET name = 'contract.start_date', label = 'Decorrenza contratto' WHERE name = 'service_period_start' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'contract.start_date');
UPDATE fields SET name = 'contract.end_date', label = 'Fine contratto' WHERE name = 'service_period_end' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'contract.end_date');
UPDATE fields SET name = 'document.protocol_number', label = 'Numero protocollo' WHERE name = 'protocol_number' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'document.protocol_number');
UPDATE fields SET name = 'company.tax_id', label = 'CF/P.IVA impresa' WHERE name = 'tax_code' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'company.tax_id');
UPDATE fields SET name = 'insurance.policy_number', label = 'Numero polizza' WHERE name = 'policy_number' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'insurance.policy_number');
UPDATE fields SET name = 'utility.account_id', label = 'Codice utenza/cliente' WHERE name = 'account_identifier' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'utility.account_id');
UPDATE fields SET name = 'employment.employee_name', label = 'Lavoratore' WHERE name = 'employee_name' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'employment.employee_name');
UPDATE fields SET name = 'employment.job_title', label = 'Mansione/qualifica' WHERE name = 'job_title' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'employment.job_title');
UPDATE fields SET name = 'hse.site', label = 'Cantiere/sito' WHERE name = 'site_name' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'hse.site');
UPDATE fields SET name = 'tax.period', label = 'Periodo d''imposta' WHERE name = 'tax_period' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'tax.period');
UPDATE fields SET name = 'payment.reference', label = 'Riferimento pagamento' WHERE name = 'payment_reference' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'payment.reference');
UPDATE fields SET name = 'logistics.goods', label = 'Merci' WHERE name = 'goods_description' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'logistics.goods');
UPDATE fields SET name = 'hse.risk_type', label = 'Tipo rischio' WHERE name = 'hazard_or_activity' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'hse.risk_type');
UPDATE fields SET name = 'document.legal_basis', label = 'Base giuridica' WHERE name = 'legal_basis' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'document.legal_basis');
UPDATE fields SET name = 'privacy.processing_purpose', label = 'Finalità trattamento' WHERE name = 'processing_purpose' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'privacy.processing_purpose');
UPDATE fields SET name = 'it.recovery_target', label = 'Obiettivo ripristino' WHERE name = 'recovery_target' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'it.recovery_target');
UPDATE fields SET name = 'it.severity', label = 'Gravità' WHERE name = 'severity' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'it.severity');
UPDATE fields SET name = 'it.system', label = 'Sistema/servizio' WHERE name = 'system_or_service' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'it.system');
UPDATE fields SET name = 'logistics.package_count', label = 'Numero colli' WHERE name = 'package_count' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'logistics.package_count');
UPDATE fields SET name = 'utility.consumption', label = 'Consumo' WHERE name = 'consumption' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'utility.consumption');
UPDATE fields SET name = 'money.amount', label = 'Importo' WHERE name = 'customs_value' AND NOT EXISTS (SELECT 1 FROM fields AS f2 WHERE f2.document_id = fields.document_id AND f2.name = 'money.amount');
