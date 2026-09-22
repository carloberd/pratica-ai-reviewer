/**
 * I nomi campo del motore v1 portati sugli id dell'ontologia.
 *
 * Non è più un file del registry: il registry ha due file e nessuno dei due parla la
 * lingua del v1. La tabella però serve ancora, perché nel database ci sono documenti
 * revisionati quando i campi si chiamavano `issue_date` e `total_amount`, e le
 * correzioni scritte allora devono ritrovare il campo che oggi le porta. È una tabella
 * di migrazione, chiusa: non cresce con l'ontologia.
 *
 * Dove il pilota ha spaccato un campo grezzo in due — `company.tax_id` in partita IVA e
 * codice fiscale — il nome v1 va su quello che il documento scriveva in quel campo.
 */
export const LEGACY_FIELD_MAP: Record<string, string> = {
  document_number: 'document.number',
  issue_date: 'document.issue_date',
  issuer_name: 'issuer.name',
  recipient_name: 'recipient.name',
  taxable_amount: 'money.taxable',
  tax_amount: 'money.tax',
  total_amount: 'money.total',
  currency: 'money.currency',
  amount: 'money.amount',
  premium_amount: 'insurance.premium',
  payment_date: 'payment.date',
  transaction_date: 'finance.transaction_date',
  effective_date: 'document.effective_date',
  declaration_date: 'document.declaration_date',
  shipment_date: 'logistics.shipment_date',
  coverage_start: 'insurance.coverage_start',
  coverage_end: 'insurance.coverage_end',
  period_start: 'utility.period_start',
  period_end: 'utility.period_end',
  service_period_start: 'contract.start_date',
  service_period_end: 'contract.end_date',
  protocol_number: 'document.protocol_number',
  tax_code: 'company.tax_code',
  policy_number: 'insurance.policy_number',
  account_identifier: 'utility.account_id',
  employee_name: 'employment.employee_name',
  job_title: 'employment.job_title',
  site_name: 'hse.site',
  tax_period: 'tax.period',
  payment_reference: 'payment.reference',
  goods_description: 'logistics.goods',
  hazard_or_activity: 'hse.risk_type',
  legal_basis: 'document.legal_basis',
  processing_purpose: 'privacy.processing_purpose',
  recovery_target: 'it.recovery_target',
  severity: 'it.severity',
  system_or_service: 'it.system',
  package_count: 'logistics.package_count',
  consumption: 'utility.consumption',
  customs_value: 'money.amount'
}
