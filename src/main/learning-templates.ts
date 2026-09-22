import {
  DEFAULT_LEARNING_POLICY,
  type LearningRule,
  type LearningRuleInput,
  templateTypeRuleKey
} from '@shared/local-learning'
import {
  isNormalizedTemplateSignature,
  type NormalizedTemplateSignature,
  templateSignatureSimilarity
} from '@shared/template-fingerprint'

/**
 * Un modulo riconosciuto, col tipo con cui le revisioni l'hanno chiuso. Era quello che il
 * classificatore leggeva per decidere; ora nessuno decide il tipo al posto del revisore, e
 * resta l'audit: il run dice quali moduli erano già passati di qui.
 */
export interface TemplateMemory {
  documentType: string
  templateFingerprint: string
  /** 1 se l'impronta è identica, altrimenti quanto le testate si somigliano. */
  similarity: number
}

/**
 * La memoria dei moduli: un template che le revisioni hanno chiuso sempre con lo stesso tipo.
 *
 * È la parte di classificazione che il learner impara per prima perché costa poco e sbaglia
 * poco: non ricava frasi dal testo, conta solo quante volte lo stesso stampato è stato
 * chiuso con quale tipo. Nessun dato del documento entra nella regola, solo l'impronta.
 *
 * Dalla 0016 «lo stesso stampato» non è più solo l'impronta identica. Con `minTemplateTypeSupport`
 * a 3 e un'impronta che valeva per un documento solo, questa memoria non poteva attivarsi
 * mai; la firma normalizzata raggruppa gli esemplari, e le revisioni si sommano.
 */

/** La regola di un modulo per un tipo. */
export function templateTypeRuleInput(
  documentType: string,
  templateFingerprint: string,
  templateSignature?: NormalizedTemplateSignature | null
): LearningRuleInput {
  return {
    kind: 'TEMPLATE_TYPE',
    scope: 'TEMPLATE',
    documentType,
    fieldId: null,
    // L'impronta esatta di questo esemplare resta scritta: è quella che fa da chiave per le
    // regole di prima della firma, e serve a ritrovare la coda da rielaborare.
    templateFingerprint,
    pattern: templateSignature ? { templateSignature } : {},
    ruleKey: templateTypeRuleKey(
      documentType,
      templateSignature?.fingerprint ?? templateFingerprint
    )
  }
}

/**
 * Le memorie attive che valgono per questo documento.
 *
 * Due strade, in quest'ordine: l'impronta identica, che fa valere anche le regole scritte
 * prima della firma; e, per le altre, la somiglianza delle testate sopra
 * `minTemplateSimilarity`. `similarity` esce di qui perché chi propone il tipo possa pesare
 * un modulo somigliante meno di uno identico — qui non si decide, si riporta.
 */
export function templateMemoryFor(
  rules: LearningRule[],
  templateFingerprint: string | null,
  templateSignature?: NormalizedTemplateSignature | null
): Array<TemplateMemory & { ruleId: string }> {
  if (!templateFingerprint && !templateSignature) return []
  return rules.flatMap((rule) => {
    if (rule.kind !== 'TEMPLATE_TYPE' || rule.status !== 'ACTIVE') return []
    const exact = templateFingerprint !== null && rule.templateFingerprint === templateFingerprint
    const stored = rule.pattern.templateSignature
    const similarity = isNormalizedTemplateSignature(stored)
      ? templateSignatureSimilarity(stored, templateSignature)
      : 0
    if (!exact && similarity < DEFAULT_LEARNING_POLICY.minTemplateSimilarity) return []
    return [
      {
        ruleId: rule.id,
        documentType: rule.documentType,
        templateFingerprint: templateFingerprint ?? rule.templateFingerprint ?? 'sconosciuta',
        similarity: exact ? 1 : similarity
      }
    ]
  })
}
