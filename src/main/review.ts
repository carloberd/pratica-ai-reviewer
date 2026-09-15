import type { FieldChange, ReviewDecision, ReviewDocument, ReviewPayload } from '@shared/types'

/**
 * Costruisce il payload della review.
 *
 * Chiude il gap dichiarato dal modulo v5.2, dove «Conferma con correzione» inviava
 * una decisione `CORRECT` senza alcun editor: qui `corrections` contiene solo i campi
 * realmente modificati e `changes` porta before/after e provenienza del valore di
 * partenza. La forma di `decision`/`corrections`/`note` resta quella che si aspetta
 * `POST /v1/document-understandings/{id}/reviews`; `changes` è un'aggiunta che un
 * backend fermo al contratto v5.2 può semplicemente ignorare.
 */
export function buildReviewPayload(
  document: ReviewDocument,
  decision: ReviewDecision,
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
      ? 'Documento rifiutato'
      : payload.decision === 'CORRECT'
        ? 'Approvato con correzioni'
        : 'Documento approvato'

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
