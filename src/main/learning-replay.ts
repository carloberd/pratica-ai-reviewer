import { DEFAULT_LEARNING_POLICY, type LearningPolicy } from '@shared/local-learning'
import type { Repository } from './db/repository'
import type { ExtractionRegistryV2 } from './extract/v2/profile-loader'
import { learnFromReview, type RulesChange } from './review-learning'

/**
 * Le revisioni già chiuse, ripassate per il learner.
 *
 * Il learner è stato acceso dopo che la revisione era già cominciata. Sull'export del
 * 18/09/2026 aveva **122 eventi su 11 documenti**, contro 281 correzioni su 41: le
 * revisioni chiuse prima non gliele aveva viste nessuno, e quello che avrebbero insegnato
 * era perso — non perché non ci fosse, ma perché nessuno l'aveva letto. Valori, correzioni
 * e selezioni stanno a database, e da lì si ricava esattamente quello che `submitReview`
 * avrebbe registrato al momento della chiusura.
 *
 * Il replay è **idempotente**: `learnFromReview` comincia ritirando le prove di quel
 * documento (`retractDocument`), quindi rilanciarlo non gonfia i contatori. Un documento
 * già registrato viene semplicemente riscritto com'era.
 *
 * Ogni evento porta `at` = quando il revisore aveva chiuso, e `replayedAt` = adesso.
 * `actor` è l'account che lancia il replay: chi aveva chiuso davvero non è mai stato
 * salvato sul documento, e `replayedAt` è lì perché il registro non dica una cosa che non
 * sa.
 *
 * Va lanciato **dopo** aver sistemato l'impronta dei moduli, non prima: con un'impronta
 * che cambia a ogni documento il replay non fa che moltiplicare regole a support 1.
 */

export interface ReplayResult {
  /** Documenti chiusi trovati. */
  documents: number
  /**
   * Quelli che hanno lasciato qualcosa nel registro. Gli altri non avevano niente da
   * insegnare, o il learner non era in LEARNING e non registra: il ripasso è una
   * registrazione come le altre, e le modalità valgono anche per lui.
   */
  replayed: number
  /** Quello che è cambiato, da rielaborare. */
  changed: RulesChange
}

export interface ReplayInput {
  repo: Repository
  /** L'account che lancia il replay: finisce come `actor` degli eventi ripassati. */
  actor: string
  registry?: ExtractionRegistryV2 | undefined
  now?: Date
  policy?: LearningPolicy
}

export function replayReviews(input: ReplayInput): ReplayResult {
  const { repo, actor } = input
  const at = (input.now ?? new Date()).toISOString()
  const policy = input.policy ?? DEFAULT_LEARNING_POLICY

  const rows = repo.documents.list({ status: 'REVIEWED' })
  const documentTypes = new Set<string>()
  const templateFingerprints = new Set<string>()
  let replayed = 0

  for (const row of rows) {
    const document = repo.getReviewDocument(row.id)
    if (!document) continue
    const learned = repo.transaction(() =>
      learnFromReview(repo, {
        document,
        action: 'SAVE',
        // Il momento della decisione resta quello della chiusura: è quello che conta per
        // la cronologia, e due chiusure diverse non devono sembrare la stessa sessione.
        at: row.reviewed_at ?? at,
        actor,
        registry: input.registry,
        policy,
        replayedAt: at
      })
    )
    if (learned.events === 0) continue
    replayed += 1
    for (const type of learned.changed.documentTypes) documentTypes.add(type)
    for (const print of learned.changed.templateFingerprints) templateFingerprints.add(print)
  }

  return {
    documents: rows.length,
    replayed,
    changed: {
      documentTypes: [...documentTypes],
      templateFingerprints: [...templateFingerprints]
    }
  }
}
