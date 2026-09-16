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

export function isItalianTaxIdLike(value: string): boolean {
  const cleaned = value.replace(/\s+/g, '').toUpperCase()
  return /^\d{11}$/.test(cleaned) || /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/.test(cleaned)
}

/**
 * Esegue un validatore dell'ontologia su un valore già normalizzato.
 *
 * I valori arrivano come stringhe (`yyyy-mm-dd`, `1234.50`): è la forma in cui finiscono
 * nella colonna `fields.value`, quindi importi e numeri si validano anche come testo.
 * Un validatore che questo modulo non conosce non blocca nulla.
 */
export function runFieldValidator(name: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return 'EMPTY'
  const text = typeof value === 'string' ? value : null
  if (name === 'iban_checksum' && text !== null && !isValidIban(text)) return 'INVALID_IBAN'
  if (name === 'valid_date' && text !== null && !isValidDate(text)) return 'INVALID_DATE'
  if (name === 'tax_id_format' && text !== null && !isItalianTaxIdLike(text)) {
    return 'INVALID_TAX_ID_FORMAT'
  }
  if (name === 'italian_tax_code_format' && text !== null && !isItalianTaxIdLike(text)) {
    return 'INVALID_CF_FORMAT'
  }
  if (name === 'non_negative_money') {
    const amount = typeof value === 'number' ? value : Number(text)
    if (Number.isFinite(amount) && amount < 0) return 'NEGATIVE_MONEY'
  }
  return null
}
