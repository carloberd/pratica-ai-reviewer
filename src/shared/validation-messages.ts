/**
 * Cosa vuol dire, per chi rivede, un validatore fallito. I codici sono quelli di
 * `src/main/extract/v2/validators.ts`; uno che qui non c'è si mostra com'è.
 *
 * I messaggi dicono cosa non torna, non cosa fare: un documento può riportare davvero un
 * codice sbagliato, e il compito è trascriverlo.
 */
const MESSAGES: Record<string, string> = {
  INVALID_IBAN: 'IBAN che non torna: il codice di controllo è sbagliato.',
  INVALID_TAX_ID_FORMAT: 'Non ha la forma di una partita IVA né di un codice fiscale.',
  INVALID_TAX_ID_CHECKSUM:
    'Il carattere di controllo non torna: un carattere letto o scritto male?',
  INVALID_VAT_FORMAT: 'Non ha la forma di una partita IVA: 11 cifre.',
  INVALID_VAT_CHECKSUM:
    'La cifra di controllo della partita IVA non torna: una cifra letta o scritta male?',
  INVALID_CF_FORMAT: 'Non ha la forma di un codice fiscale.',
  INVALID_CF_CHECKSUM:
    'Il carattere di controllo del codice fiscale non torna: un carattere letto o scritto male?',
  INVALID_DATE: 'Non è una data.',
  NEGATIVE_MONEY: 'Importo negativo.',
  INVALID_VEHICLE_PLATE: 'Non ha la forma di una targa (AA 000 AA).',
  INVALID_VIN: 'Un telaio ha 17 caratteri, senza I, O e Q.'
}

export function validationMessage(code: string): string {
  return MESSAGES[code] ?? code
}
