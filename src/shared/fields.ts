import type { SemanticType } from './types'

/**
 * Closed set dei 40 campi dichiarati dagli `extraction_schemas.json` del registry
 * PraticaAI (511 tipi). Nessun tipo ne dichiara altri: se ne comparissero, la
 * precompilazione li ignora e il campo resta vuoto.
 *
 * Divergenza nota rispetto al registry: `package_count` e `consumption` sono
 * dichiarati `number` negli schemi, ma qui sono trattati come `string` perché in
 * pratica portano unità di misura ("12 colli", "540 kWh") che non sopravvivono a
 * una normalizzazione monetaria.
 */
export const FIELD_SEMANTIC_TYPES = {
  // date (12)
  coverage_end: 'date',
  coverage_start: 'date',
  declaration_date: 'date',
  effective_date: 'date',
  issue_date: 'date',
  payment_date: 'date',
  period_end: 'date',
  period_start: 'date',
  service_period_end: 'date',
  service_period_start: 'date',
  shipment_date: 'date',
  transaction_date: 'date',
  // money (6)
  amount: 'money',
  customs_value: 'money',
  premium_amount: 'money',
  tax_amount: 'money',
  taxable_amount: 'money',
  total_amount: 'money',
  // string (22)
  account_identifier: 'string',
  consumption: 'string',
  currency: 'string',
  document_number: 'string',
  employee_name: 'string',
  goods_description: 'string',
  hazard_or_activity: 'string',
  issuer_name: 'string',
  job_title: 'string',
  legal_basis: 'string',
  package_count: 'string',
  payment_reference: 'string',
  policy_number: 'string',
  processing_purpose: 'string',
  protocol_number: 'string',
  recipient_name: 'string',
  recovery_target: 'string',
  severity: 'string',
  site_name: 'string',
  system_or_service: 'string',
  tax_code: 'string',
  tax_period: 'string'
} as const satisfies Record<string, SemanticType>

export type RegistryFieldName = keyof typeof FIELD_SEMANTIC_TYPES

/** Etichette italiane della UI. Una per ognuno dei 40 campi. */
export const FIELD_LABELS: Record<RegistryFieldName, string> = {
  account_identifier: 'Identificativo conto o utenza',
  amount: 'Importo',
  consumption: 'Consumo',
  coverage_end: 'Fine copertura',
  coverage_start: 'Inizio copertura',
  currency: 'Valuta',
  customs_value: 'Valore doganale',
  declaration_date: 'Data della dichiarazione',
  document_number: 'Numero documento',
  effective_date: 'Data di decorrenza',
  employee_name: 'Nome del dipendente',
  goods_description: 'Descrizione delle merci',
  hazard_or_activity: 'Rischio o attività',
  issue_date: 'Data di emissione',
  issuer_name: 'Emittente',
  job_title: 'Mansione',
  legal_basis: 'Base giuridica',
  package_count: 'Numero di colli',
  payment_date: 'Data di pagamento',
  payment_reference: 'Riferimento del pagamento',
  period_end: 'Fine periodo',
  period_start: 'Inizio periodo',
  policy_number: 'Numero di polizza',
  premium_amount: 'Premio',
  processing_purpose: 'Finalità del trattamento',
  protocol_number: 'Numero di protocollo',
  recipient_name: 'Destinatario',
  recovery_target: 'Obiettivo di ripristino',
  service_period_end: 'Fine del periodo di servizio',
  service_period_start: 'Inizio del periodo di servizio',
  severity: 'Gravità',
  shipment_date: 'Data di spedizione',
  site_name: 'Sito',
  system_or_service: 'Sistema o servizio',
  tax_amount: 'Imposta',
  tax_code: 'Codice fiscale o partita IVA',
  tax_period: "Periodo d'imposta",
  taxable_amount: 'Imponibile',
  total_amount: 'Totale',
  transaction_date: "Data dell'operazione"
}

/** I 4 campi dichiarati da tutti e 511 i tipi del registry. */
export const UNIVERSAL_FIELDS: RegistryFieldName[] = [
  'document_number',
  'issue_date',
  'issuer_name',
  'recipient_name'
]

export function isRegistryField(name: string): name is RegistryFieldName {
  return Object.hasOwn(FIELD_SEMANTIC_TYPES, name)
}

export function fieldLabel(name: string): string {
  return isRegistryField(name) ? FIELD_LABELS[name] : name
}

export function fieldSemanticType(name: string): SemanticType {
  return isRegistryField(name) ? FIELD_SEMANTIC_TYPES[name] : 'string'
}

/**
 * Il campo porta una data.
 *
 * Lo dice il tipo semantico del profilo v2 dove c'è; sulle righe scritte dal motore v1 la
 * colonna è nulla, e allora lo dice il nome — `document.issue_date`, `identity.expiry_date`,
 * `person.birth_date` finiscono tutti in `_date`, e così i quattro universali del v1.
 */
export function isDateField(semanticType: string | null, name: string): boolean {
  if (semanticType) return semanticType === 'date'
  return fieldSemanticType(name) === 'date' || /_date$/.test(name)
}

/** Ordine stabile in UI: prima gli universali, poi gli specifici in ordine alfabetico di etichetta. */
export function sortFieldNames(names: string[]): string[] {
  const universal = UNIVERSAL_FIELDS.filter((n) => names.includes(n))
  const rest = names
    .filter((n) => !UNIVERSAL_FIELDS.includes(n as RegistryFieldName))
    .sort((a, b) => fieldLabel(a).localeCompare(fieldLabel(b), 'it'))
  return [...universal, ...rest]
}
