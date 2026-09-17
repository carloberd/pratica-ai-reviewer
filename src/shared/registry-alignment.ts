/**
 * Gli id dei tipi che il reviewer e pratica-ai chiamano in due modi.
 *
 * Il reviewer parla la lingua del programmer pack (`resources/registry/v2`), pratica-ai
 * quella del suo `document-registry` V5.1. Sulle 500 classi coincidono, meno tre: sono
 * classi che i due progetti hanno aggiunto per conto proprio, con lo stesso nome canonico e
 * uno slug diverso. Nessuno dei due file si tocca — sono snapshot, e la regola è la stessa
 * di là: il registry non si modifica, si somma qualcosa in lettura — quindi la traduzione
 * sta qui e si applica alle frontiere: gli id che escono negli export e quelli che entrano
 * da un'assegnazione a mano.
 *
 * Non sono un disallineamento le classi che esistono da un lato solo
 * (`certifications_licenses.ricevuta_presentazione_suap` e
 * `governance_compliance.questionario_adeguata_verifica_cliente_aml` qui;
 * `fiscal_tax.durf`, `finance_corporate.piano_finanziario` e
 * `payroll_contributions.rateazione_inps` di là): sono vocabolari a versioni diverse, e si
 * allineano quando uno dei due pacchetti si aggiorna.
 */

/** Una classe che i due progetti hanno aggiunto con slug diversi. */
export interface TypeAlias {
  /** Come la chiama il programmer pack, cioè il database di questa app. */
  reviewer: string
  /** Come la chiama il registry di pratica-ai. */
  praticaai: string
  canonicalName: string
}

export const PRATICAAI_TYPE_ALIASES: readonly TypeAlias[] = [
  {
    reviewer: 'contracts_general.contratto_raggruppamento_temporaneo_imprese',
    praticaai: 'contracts_general.rti',
    canonicalName: 'contratto raggruppamento temporaneo imprese'
  },
  {
    reviewer: 'hse_risk.autocertificazione_idoneita_tecnico_professionale',
    praticaai: 'hse_risk.idoneita_autocertificazione',
    canonicalName: 'autocertificazione idoneità tecnico-professionale'
  },
  {
    reviewer: 'payroll_contributions.dichiarazione_regolarita_retributiva',
    praticaai: 'payroll_contributions.regolarita_retributiva',
    canonicalName: 'dichiarazione regolarità retributiva'
  }
]

const TO_PRATICAAI = new Map(
  PRATICAAI_TYPE_ALIASES.map((entry) => [entry.reviewer, entry.praticaai])
)
const TO_REVIEWER = new Map(
  PRATICAAI_TYPE_ALIASES.map((entry) => [entry.praticaai, entry.reviewer])
)

/**
 * Lo stesso tipo come lo chiama pratica-ai. Un id che non ha alias resta com'è: i due
 * vocabolari coincidono quasi sempre, e un id sconosciuto non si traduce a indovinare.
 */
export function praticaaiTypeId(documentType: string): string {
  return TO_PRATICAAI.get(documentType) ?? documentType
}

/** Lo stesso, per gli id nullabili degli export. */
export function praticaaiTypeIdOrNull(documentType: string | null): string | null {
  return documentType === null ? null : praticaaiTypeId(documentType)
}

/**
 * Lo stesso tipo come lo chiama questa app: serve a chi incolla uno slug preso da
 * pratica-ai nell'assegnazione manuale del tipo, che altrimenti resterebbe senza profilo.
 */
export function reviewerTypeId(documentType: string): string {
  return TO_REVIEWER.get(documentType) ?? documentType
}
