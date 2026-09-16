import type {
  FieldChange,
  QueueStatus,
  ReviewAction,
  ReviewDecision,
  ReviewDocument,
  ReviewPayload
} from '@shared/types'

/** Lo stato in cui l'azione lascia il documento, cioè se entrerà nel dataset o no. */
export function statusForAction(action: ReviewAction): QueueStatus {
  return action === 'DISCARD' ? 'DISCARDED' : 'REVIEWED'
}

/**
 * Costruisce il payload della review.
 *
 * Il revisore sceglie fra due sole azioni — salvare o scartare — perché la terza del
 * modulo v5.2 («Conferma con correzione») non portava informazione: `APPROVE` e
 * `CORRECT` finivano nello stesso stato, e quale delle due fosse dipendeva solo dai
 * campi toccati. Qui la `decision` la deriviamo da quelli, così la forma
 * `decision`/`corrections`/`note` attesa da
 * `POST /v1/document-understandings/{id}/reviews` resta valida senza chiedere a nessuno
 * di ricalcolarla a mano. `changes` porta before/after e provenienza del valore di
 * partenza: è un'aggiunta che un backend fermo al contratto v5.2 può ignorare.
 */
export function buildReviewPayload(
  document: ReviewDocument,
  action: ReviewAction,
  note?: string
): ReviewPayload {
  const changes: FieldChange[] = document.fields
    .filter((field) => field.correctedValue !== undefined && field.correctedValue !== field.value)
    .map((field) => ({
      fieldId: field.id,
      name: field.name,
      label: field.label,
      before: field.value,
      after: field.correctedValue ?? '',
      provenance: {
        textSource: document.textSource,
        ...(field.evidenceId ? { evidenceId: field.evidenceId } : {}),
        confidence: field.confidence
      }
    }))

  const corrections = Object.fromEntries(changes.map((change) => [change.name, change.after]))
  const decision: ReviewDecision =
    action === 'DISCARD' ? 'REJECT' : changes.length > 0 ? 'CORRECT' : 'APPROVE'

  return {
    decision,
    ...(changes.length > 0 ? { corrections, changes } : {}),
    ...(note ? { note } : {})
  }
}

/** Riga di timeline leggibile per una decisione di revisione. */
export function describeReview(payload: ReviewPayload): { title: string; detail: string } {
  const title =
    payload.decision === 'REJECT'
      ? 'Documento scartato'
      : payload.decision === 'CORRECT'
        ? 'Revisionato con correzioni'
        : 'Documento revisionato'

  const changes = payload.changes ?? []
  const parts: string[] = []

  if (changes.length === 0) {
    parts.push('Nessun campo modificato.')
  } else {
    parts.push(
      changes.length === 1 ? '1 campo corretto:' : `${changes.length} campi corretti:`,
      changes
        .map(
          (change) =>
            `${change.label} «${change.before || '(vuoto)'}» → «${change.after || '(vuoto)'}»`
        )
        .join('; ')
    )
  }

  if (payload.note) parts.push(`Nota: ${payload.note}`)
  return { title, detail: parts.join(' ') }
}
