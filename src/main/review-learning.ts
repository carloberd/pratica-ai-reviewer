import { LEARNING_MODE_LABELS } from '@shared/local-learning'
import { describeLearnedReview, reviewLearningEvents } from '@shared/review-learning'
import type { ReviewAction, ReviewDocument } from '@shared/types'
import type { Repository } from './db/repository'

/**
 * La revisione salvata, registrata per il learner.
 *
 * Si impara qui e non a ogni modifica di un campo: mentre il revisore lavora i valori sono
 * provvisori, e il salvataggio è la decisione finale. Il documento è quello letto prima di
 * chiudere, con tipo, campi e selezioni come il revisore li ha lasciati.
 *
 * Va chiamata dentro la transazione che chiude il documento: una revisione salvata senza i
 * suoi eventi perderebbe l'unico dato che non si può ricostruire, e degli eventi senza la
 * revisione insegnerebbero qualcosa che non è successo.
 *
 * Ritorna la frase per la timeline, `null` quando non c'è niente da dire (uno scarto).
 */
export function learnFromReview(
  repo: Repository,
  input: {
    document: ReviewDocument
    action: ReviewAction
    at: string
    /** Chi ha salvato: l'account collegato. `null` se non si sa, e allora non si registra. */
    actor: string | null
  }
): string | null {
  // Un documento scartato è fuori dal dataset, e fuori da quello che il motore impara.
  if (input.action !== 'SAVE') return null

  const mode = repo.learning.mode()
  if (mode !== 'LEARNING') return `${LEARNING_MODE_LABELS[mode]}: revisione non registrata.`
  if (!input.actor) {
    return 'Apprendimento: revisione non registrata, nessun account collegato.'
  }

  const events = reviewLearningEvents(input.document, {
    at: input.at,
    actor: input.actor,
    templateFingerprint: repo.documents.get(input.document.id)?.template_fingerprint ?? null
  })
  repo.learning.acquire((writer) => {
    for (const event of events) writer.addEvent(event)
  })
  return describeLearnedReview(events)
}
