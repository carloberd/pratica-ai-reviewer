import type { FieldOntologyEntry } from '@shared/extraction-v2'
import { currentFieldValue, currentItemValue } from '@shared/field-edits'
import {
  type AnchorPattern,
  type AnchorRelation,
  anchorRuleKey,
  DEFAULT_LEARNING_POLICY,
  isAnchorPattern,
  type LearningRule,
  type LearningRuleInput,
  type LearningRuleScope
} from '@shared/local-learning'
import type { PageLine } from '@shared/pick-locate'
import {
  type NormalizedTemplateSignature,
  templateSignatureSimilarity
} from '@shared/template-fingerprint'
import type { PickLocation, ReviewDocument } from '@shared/types'
import { fold } from './extract/heuristics'
import { type LearnedLabel, readsOfLabel } from './extract/v2/fact-reader'

/**
 * Dal punto in cui il revisore ha preso un valore all'etichetta che lo annuncia.
 *
 * L'etichetta è quella che il motore userebbe: le ultime parole prima del valore sulla sua
 * riga, oppure la fine della riga sopra se il valore sta in testa alla riga. Una candidata
 * vale solo se, letta con le regole dell'estrazione su quella pagina, legge un valore in un
 * punto solo, e quel punto è la selezione. Fra quelle che passano vince la più corta: è la
 * meno legata a quel documento.
 *
 * Mai cifre nell'etichetta: numeri, date e importi cambiano da un documento all'altro, e
 * un'etichetta con dentro «27/2026» non ritroverebbe il valore sul documento dopo.
 */

/** Parole al massimo in un'etichetta imparata: di più è testo del documento, non un'etichetta. */
export const MAX_LABEL_WORDS = 3

/** Lettere minime: «n.» da solo non annuncia niente. */
const MIN_LABEL_LETTERS = 3

/** Una parola che chiude un'altra coppia etichetta-valore: «Emittente:» in «Emittente: Beta P.IVA». */
const LABEL_TERMINATOR = /[:=]$/

/**
 * Le etichette possibili in un testo che precede un valore, dalla più corta. Si risale
 * dalla fine finché le parole non hanno cifre, fino a `MAX_LABEL_WORDS`, e senza scavalcare
 * un'altra etichetta.
 */
export function candidateLabels(text: string): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const trailing: string[] = []
  for (let index = words.length - 1; index >= 0 && trailing.length < MAX_LABEL_WORDS; index -= 1) {
    const word = words[index]!
    if (/\d/.test(word) || word.includes('@')) break
    if (trailing.length > 0 && LABEL_TERMINATOR.test(word)) break
    trailing.unshift(word)
  }
  const labels: string[] = []
  for (let size = 1; size <= trailing.length; size += 1) {
    const label = fold(trailing.slice(-size).join(' '))
    const letters = label.replace(/[^a-z]/g, '').length
    if (letters >= MIN_LABEL_LETTERS && !labels.includes(label)) labels.push(label)
  }
  return labels
}

/**
 * L'etichetta che annuncia il valore selezionato, o `null` se non ce n'è una sicura: la
 * selezione non ha offset, prende più righe, o nessuna candidata legge solo quel valore.
 */
export function deriveAnchor(input: {
  lines: PageLine[]
  location: PickLocation
  fieldId: string
  spec: FieldOntologyEntry
}): AnchorPattern | null {
  const { lines, location } = input
  if (location.charStart === null || location.lineStart !== location.lineEnd) return null
  const lineIndex = location.lineStart
  const line = lines[lineIndex]
  if (!line) return null

  const lineOffset = lines
    .slice(0, lineIndex)
    .reduce((offset, previous) => offset + previous.text.length + 1, 0)
  const column = location.charStart - lineOffset
  if (column < 0 || column > line.text.length) return null

  const before = line.text.slice(0, column)
  const relation: AnchorRelation = /\p{L}/u.test(before) ? 'same-line' : 'next-line'
  if (relation === 'next-line' && lineIndex === 0) return null
  const source = relation === 'same-line' ? before : lines[lineIndex - 1]!.text

  for (const label of candidateLabels(source)) {
    const reads = readsOfLabel(input.fieldId, input.spec, lines, label, relation)
    if (reads.length !== 1) continue
    const [read] = reads
    if (read!.valueLine !== lineIndex) continue
    if (relation === 'same-line' && read!.labelEnd > column) continue
    return { label, relation }
  }
  return null
}

/**
 * Le parole che in questo documento sono un dato, non un'etichetta: quelle dei valori
 * confermati degli **altri** campi.
 *
 * Un'etichetta si ricava dal testo che precede il valore, e su un documento italiano quel
 * testo è spesso il nome di qualcuno. Nell'export del 18/09/2026 il learner aveva imparato
 * questa, di scope CLASS:
 *
 * ```
 * procurement.preventivo | document.issue_date | label «massetti» same-line
 * ```
 *
 * «Massetti» è il nome del cliente, non un'etichetta di preventivo: come ancora di classe
 * si applicherebbe a tutti i preventivi, sbagliando su ogni cliente diverso.
 *
 * Il campo dell'ancora resta fuori dall'insieme: la sua etichetta precede il suo valore,
 * quindi non ne fa parte, e toglierlo protegge le etichette buone che somigliano al valore
 * che annunciano — «Comune» davanti a «Comune di Rovigo».
 *
 * ## Quale dei due id
 *
 * Un campo ne ha due: `id`, la riga su cui sta in questo documento, e `name`, il nome
 * ontologico del registry. Gli eventi del learner portano sempre il secondo — li costruisce
 * `reviewLearningEvents` con `fieldId: field.name` — quindi qui si accettano entrambi.
 * Confrontare solo l'`id` lasciava l'esclusione senza effetto su ogni revisione vera: il
 * valore dell'ancora rientrava fra le parole-dato e affossava la propria regola di classe.
 */
export function documentEntityWords(document: ReviewDocument, exceptFieldId: string): Set<string> {
  const words = new Set<string>()
  for (const field of document.fields) {
    if (field.id === exceptFieldId || field.name === exceptFieldId) continue
    const values = [currentFieldValue(field), ...field.items.map(currentItemValue)]
    for (const value of values) {
      if (!value) continue
      for (const word of fold(value).split(' ')) {
        if (word.replace(/[^a-z]/g, '').length >= MIN_LABEL_LETTERS) words.add(word)
      }
    }
  }
  return words
}

/** L'etichetta è fatta di parole che in questo documento sono un dato. */
function madeOfDocumentData(label: string, entityWords: Set<string>): boolean {
  const words = label.split(' ').filter(Boolean)
  return words.length > 0 && words.every((word) => entityWords.has(word))
}

/**
 * Le regole che una selezione insegna: una per il tipo, e una per il template quando il
 * documento ha un'impronta. La stessa etichetta vale di più sul modulo da cui viene.
 *
 * Un'etichetta fatta delle parole che in questo documento sono un dato non diventa una
 * regola di **classe**: varrebbe per tutti i documenti del tipo, e funzionerebbe solo su
 * quelli dello stesso cliente. Di **template** sì: sullo stesso stampato il nome di chi
 * lo emette è parte del modulo, non del dato.
 */
export function anchorRuleInputs(input: {
  pattern: AnchorPattern
  documentType: string
  fieldId: string
  templateFingerprint: string | null
  /** La testata di questo documento: entra nella regola di template, e la fa ritrovare. */
  templateSignature?: NormalizedTemplateSignature | null
  /** Le parole che qui sono un dato; vuoto se non si sa, e allora si impara come prima. */
  entityWords?: Set<string>
}): LearningRuleInput[] {
  const scopes: LearningRuleScope[] = []
  if (input.templateFingerprint) scopes.push('TEMPLATE')
  // Senza impronta e con un'etichetta che è un dato non resta niente da imparare: quella
  // regola varrebbe per un documento solo, e non è lì che sta il documento.
  if (!madeOfDocumentData(input.pattern.label, input.entityWords ?? new Set())) scopes.push('CLASS')

  return scopes.map((scope) => {
    const templateFingerprint = scope === 'TEMPLATE' ? input.templateFingerprint : null
    // La firma sta solo sulla regola di template: è lì che serve a dire «lo stesso modulo».
    const pattern =
      scope === 'TEMPLATE' && input.templateSignature
        ? { ...input.pattern, templateSignature: input.templateSignature }
        : { ...input.pattern }
    return {
      kind: 'EXTRACTION_ANCHOR',
      scope,
      documentType: input.documentType,
      fieldId: input.fieldId,
      templateFingerprint,
      pattern,
      ruleKey: anchorRuleKey({ ...input, scope, templateFingerprint, pattern })
    }
  })
}

/**
 * Le etichette delle regole attive che valgono per un documento: del suo tipo, e di tipo o
 * del suo template.
 *
 * «Il suo template» sono due cose: l'impronta identica, che fa valere anche le regole
 * scritte prima della firma, e una testata abbastanza somigliante. Senza la seconda una
 * regola di template varrebbe soltanto sul documento da cui è stata imparata.
 */
export function learnedLabelsFor(
  rules: LearningRule[],
  documentType: string,
  templateFingerprint: string | null,
  templateSignature?: NormalizedTemplateSignature | null
): LearnedLabel[] {
  return rules.flatMap((rule) => {
    if (rule.kind !== 'EXTRACTION_ANCHOR' || rule.status !== 'ACTIVE') return []
    if (rule.documentType !== documentType || !rule.fieldId) return []
    if (!isAnchorPattern(rule.pattern)) return []
    if (
      rule.scope === 'TEMPLATE' &&
      !sameTemplate(rule.templateFingerprint, rule.pattern, templateFingerprint, templateSignature)
    ) {
      return []
    }
    return [
      {
        ruleId: rule.id,
        fieldId: rule.fieldId,
        label: rule.pattern.label,
        relation: rule.pattern.relation,
        scope: rule.scope
      }
    ]
  })
}

/** Lo stesso modulo: impronta identica, oppure testate abbastanza somiglianti. */
function sameTemplate(
  ruleFingerprint: string | null,
  rulePattern: AnchorPattern,
  templateFingerprint: string | null,
  templateSignature: NormalizedTemplateSignature | null | undefined
): boolean {
  if (templateFingerprint !== null && ruleFingerprint === templateFingerprint) return true
  return (
    templateSignatureSimilarity(rulePattern.templateSignature, templateSignature) >=
    DEFAULT_LEARNING_POLICY.minTemplateSimilarity
  )
}
