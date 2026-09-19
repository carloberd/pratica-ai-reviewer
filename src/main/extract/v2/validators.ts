import type { ClassExtractionProfile, FieldOntologyEntry } from '@shared/extraction-v2'
import type { ExtractionRegistryV2 } from './profile-loader'

function normalizeIban(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const moved = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of moved) {
    const expanded = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
    for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d
}

/**
 * Partita IVA o codice fiscale come si scrive nel campo: senza spazi, in maiuscolo, senza
 * il prefisso `IT` davanti alle 11 cifre («IT01479320291» è la partita IVA comunitaria).
 */
export function normalizeTaxId(value: string): string {
  const compact = value.replace(/\s+/g, '').toUpperCase()
  return /^IT\d{11}$/.test(compact) ? compact.slice(2) : compact
}

/** Undici cifre: partita IVA, o codice fiscale numerico di una società o di un ente. */
const NUMERIC_TAX_ID = /^\d{11}$/

/**
 * Codice fiscale di una persona fisica. Le posizioni numeriche possono essere lettere
 * (`LMNPQRSTUV` per 0–9): è l'omocodia, con cui l'Agenzia distingue due persone che
 * altrimenti avrebbero lo stesso codice. Il nono carattere è il mese (`A`–`T`, senza le
 * lettere che non lo codificano).
 */
const PERSONAL_TAX_CODE =
  /^[A-Z]{6}[\dLMNPQRSTUV]{2}[ABCDEHLMPRST][\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{3}[A-Z]$/

/**
 * L'undicesima cifra della partita IVA è di controllo (algoritmo di Luhn): le cifre in
 * posizione pari si raddoppiano, togliendo 9 se superano 9. Trova ogni cifra sbagliata e
 * quasi ogni scambio di due cifre vicine: gli errori tipici di una lettura OCR o di una
 * trascrizione. Undici zeri passano il conto ma non sono una partita IVA.
 */
export function isValidPartitaIva(value: string): boolean {
  if (!NUMERIC_TAX_ID.test(value) || /^0+$/.test(value)) return false
  let sum = 0
  for (let i = 0; i < 10; i += 1) {
    const digit = Number(value[i])
    const doubled = i % 2 === 1 ? digit * 2 : digit
    sum += doubled > 9 ? doubled - 9 : doubled
  }
  return (10 - (sum % 10)) % 10 === Number(value[10])
}

/** Il valore di un carattere in posizione dispari (1ª, 3ª, …) del codice fiscale. */
const CF_ODD = [
  1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23
]

/** Cifre e lettere contano allo stesso modo: `0` come `A`, `9` come `J`. */
function cfOrdinal(ch: string): number {
  return /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65
}

/**
 * Il sedicesimo carattere del codice fiscale è di controllo, calcolato sui quindici prima
 * così come sono scritti, lettere di omocodia comprese.
 */
export function isValidCodiceFiscale(value: string): boolean {
  if (!PERSONAL_TAX_CODE.test(value)) return false
  let sum = 0
  for (let i = 0; i < 15; i += 1) {
    const ordinal = cfOrdinal(value[i]!)
    sum += i % 2 === 0 ? CF_ODD[ordinal]! : ordinal
  }
  return String.fromCharCode(65 + (sum % 26)) === value[15]
}

type TaxIdCheck = 'VALID' | 'BAD_FORMAT' | 'BAD_CHECKSUM'

/**
 * Partita IVA o codice fiscale, di una persona o numerico: la forma dice quale dei due è,
 * e poi il carattere di controllo di quello. Le due risposte sbagliate restano distinte
 * perché dicono cose diverse a chi rivede: «non è un codice fiscale» e «è un codice fiscale
 * con un carattere sbagliato».
 */
export function checkTaxId(value: string): TaxIdCheck {
  const id = normalizeTaxId(value)
  if (NUMERIC_TAX_ID.test(id)) return isValidPartitaIva(id) ? 'VALID' : 'BAD_CHECKSUM'
  if (PERSONAL_TAX_CODE.test(id)) return isValidCodiceFiscale(id) ? 'VALID' : 'BAD_CHECKSUM'
  return 'BAD_FORMAT'
}

/** Targa italiana del sistema in vigore dal 1994, come la descrive `validators_v2.json`. */
const VEHICLE_PLATE = /^[A-Z]{2}\d{3}[A-Z]{2}$/
/** Numero di telaio: 17 caratteri, senza `I`, `O` e `Q`. */
const VIN = /^[A-HJ-NPR-Z\d]{17}$/

/** Targhe e telai si scrivono anche con spazi o trattini: «AB 123 CD», «AB-123-CD». */
function compactCode(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase()
}

/** I validatori che `runFieldValidator` sa eseguire: gli altri nomi non bloccano nulla. */
export const FIELD_VALIDATORS = [
  'non_empty',
  'valid_date',
  'non_negative_money',
  'iban_checksum',
  'tax_id_format',
  'italian_tax_code_format',
  'vehicle_plate',
  'vin'
] as const

/**
 * Esegue un validatore dell'ontologia su un valore già normalizzato.
 *
 * I valori arrivano come stringhe (`yyyy-mm-dd`, `1234.50`): è la forma in cui finiscono
 * nella colonna `fields.value`, quindi importi e numeri si validano anche come testo.
 * Un validatore che questo modulo non conosce non blocca nulla.
 *
 * I nomi sono quelli del pack: `tax_id_format` e `italian_tax_code_format` controllano
 * anche il carattere di controllo, non solo la forma. `vehicle_plate` e `vin` in
 * `validators_v2.json` sono regex, ma quel file non si carica: le stesse regex stanno qui.
 */
export function runFieldValidator(name: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return 'EMPTY'
  const text = typeof value === 'string' ? value : null
  if (name === 'iban_checksum' && text !== null && !isValidIban(text)) return 'INVALID_IBAN'
  if (name === 'valid_date' && text !== null && !isValidDate(text)) return 'INVALID_DATE'
  if (name === 'tax_id_format' && text !== null) {
    const check = checkTaxId(text)
    if (check === 'BAD_FORMAT') return 'INVALID_TAX_ID_FORMAT'
    if (check === 'BAD_CHECKSUM') return 'INVALID_TAX_ID_CHECKSUM'
  }
  if (name === 'italian_tax_code_format' && text !== null) {
    const check = checkTaxId(text)
    if (check === 'BAD_FORMAT') return 'INVALID_CF_FORMAT'
    if (check === 'BAD_CHECKSUM') return 'INVALID_CF_CHECKSUM'
  }
  if (name === 'vehicle_plate' && text !== null && !VEHICLE_PLATE.test(compactCode(text))) {
    return 'INVALID_VEHICLE_PLATE'
  }
  if (name === 'vin' && text !== null && !VIN.test(compactCode(text))) return 'INVALID_VIN'
  if (name === 'non_negative_money') {
    const amount = typeof value === 'number' ? value : Number(text)
    if (Number.isFinite(amount) && amount < 0) return 'NEGATIVE_MONEY'
  }
  return null
}

/**
 * I validatori di un campo su un tipo: quelli che il profilo mette al posto dell'ontologia
 * (`field_validator_overrides`), o quelli dell'ontologia. Un campo che l'ontologia non
 * conosce — i nomi del motore v1 — non ne ha.
 */
export function validatorsOf(
  profile: Pick<ClassExtractionProfile, 'field_validator_overrides'> | null | undefined,
  fieldId: string,
  spec: Pick<FieldOntologyEntry, 'validators'> | null | undefined
): string[] {
  return profile?.field_validator_overrides?.[fieldId] ?? spec?.validators ?? []
}

/**
 * Gli errori di un valore salvato, della proposta o della correzione. Un valore vuoto non
 * ne ha: che manchi lo dice già il campo vuoto.
 */
export function validationErrorsOf(
  validators: readonly string[],
  value: string | null | undefined
): string[] {
  if (value === null || value === undefined || value.trim() === '') return []
  return validators
    .map((validator) => runFieldValidator(validator, value))
    .filter((error): error is string => error !== null)
}

/**
 * Gli errori di un valore del campo `fieldName` su un documento di quel tipo, con i
 * validatori del registry v2: quello che la revisione mostra accanto al campo.
 */
export function validateFieldValue(
  registry: Pick<ExtractionRegistryV2, 'profile' | 'field'> | undefined,
  documentType: string | null,
  fieldName: string,
  value: string | null
): string[] {
  if (!registry) return []
  const profile = documentType ? registry.profile(documentType) : null
  return validationErrorsOf(validatorsOf(profile, fieldName, registry.field(fieldName)), value)
}
