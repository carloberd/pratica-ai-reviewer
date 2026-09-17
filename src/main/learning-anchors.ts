import type { FieldOntologyEntry } from '@shared/extraction-v2'
import {
  type AnchorPattern,
  type AnchorRelation,
  anchorRuleKey,
  isAnchorPattern,
  type LearningRule,
  type LearningRuleInput
} from '@shared/local-learning'
import type { PageLine } from '@shared/pick-locate'
import type { PickLocation } from '@shared/types'
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
 * Le regole che una selezione insegna: una per il tipo, e una per il template quando il
 * documento ha un'impronta. La stessa etichetta vale di più sul modulo da cui viene.
 */
export function anchorRuleInputs(input: {
  pattern: AnchorPattern
  documentType: string
  fieldId: string
  templateFingerprint: string | null
}): LearningRuleInput[] {
  const scopes = input.templateFingerprint ? (['TEMPLATE', 'CLASS'] as const) : (['CLASS'] as const)
  return scopes.map((scope) => {
    const templateFingerprint = scope === 'TEMPLATE' ? input.templateFingerprint : null
    return {
      kind: 'EXTRACTION_ANCHOR',
      scope,
      documentType: input.documentType,
      fieldId: input.fieldId,
      templateFingerprint,
      pattern: { ...input.pattern },
      ruleKey: anchorRuleKey({ ...input, scope, templateFingerprint })
    }
  })
}

/**
 * Le etichette delle regole attive che valgono per un documento: del suo tipo, e di tipo o
 * del suo template.
 */
export function learnedLabelsFor(
  rules: LearningRule[],
  documentType: string,
  templateFingerprint: string | null
): LearnedLabel[] {
  return rules.flatMap((rule) => {
    if (rule.kind !== 'EXTRACTION_ANCHOR' || rule.status !== 'ACTIVE') return []
    if (rule.documentType !== documentType || !rule.fieldId) return []
    if (rule.scope === 'TEMPLATE' && rule.templateFingerprint !== templateFingerprint) return []
    if (!isAnchorPattern(rule.pattern)) return []
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
