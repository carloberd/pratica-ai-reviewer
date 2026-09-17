import {
  type LearningRule,
  type LearningRuleInput,
  templateTypeRuleKey
} from '@shared/local-learning'
import type { TemplateMemoryV2 } from './registry/v2/classify-v2'

/**
 * La memoria dei moduli: un template che le revisioni hanno chiuso sempre con lo stesso tipo.
 *
 * È la parte di classificazione che il learner impara per prima perché costa poco e sbaglia
 * poco: non ricava frasi dal testo, conta solo quante volte lo stesso stampato è stato
 * chiuso con quale tipo. Nessun dato del documento entra nella regola, solo l'impronta.
 */

/** La regola di un modulo per un tipo. */
export function templateTypeRuleInput(
  documentType: string,
  templateFingerprint: string
): LearningRuleInput {
  return {
    kind: 'TEMPLATE_TYPE',
    scope: 'TEMPLATE',
    documentType,
    fieldId: null,
    templateFingerprint,
    pattern: {},
    ruleKey: templateTypeRuleKey(documentType, templateFingerprint)
  }
}

/** Le memorie attive per l'impronta di un documento; nessuna senza impronta. */
export function templateMemoryFor(
  rules: LearningRule[],
  templateFingerprint: string | null
): Array<TemplateMemoryV2 & { ruleId: string }> {
  if (!templateFingerprint) return []
  return rules
    .filter(
      (rule) =>
        rule.kind === 'TEMPLATE_TYPE' &&
        rule.status === 'ACTIVE' &&
        rule.templateFingerprint === templateFingerprint
    )
    .map((rule) => ({ ruleId: rule.id, documentType: rule.documentType, templateFingerprint }))
}
