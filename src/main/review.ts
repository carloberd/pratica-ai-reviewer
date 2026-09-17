import { fieldCorrections } from '@shared/field-edits'
import type {
  FieldChange,
  QueueStatus,
  ReviewAction,
  ReviewDecision,
  ReviewDocument,
  ReviewPayload
} from '@shared/types'
import type { Repository } from './db/repository'
import { ReviewerError } from './errors'
import { learnFromReview } from './review-learning'

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
    .filter(
      (field) =>
        field.cardinality !== 'many' &&
        field.correctedValue !== undefined &&
        field.correctedValue !== field.value
    )
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

  // Le righe dei campi ripetuti: una modifica per riga aggiunta, corretta o tolta. Non
  // finiscono in `corrections`, che nel contratto v5.2 è una mappa campo -> valore.
  const itemChanges: FieldChange[] = document.fields
    .filter((field) => field.cardinality === 'many')
    .flatMap(fieldCorrections)
    .map((correction) => {
      const item = document.fields
        .find((field) => field.id === correction.fieldId)
        ?.items.find((candidate) => candidate.id === correction.itemId)
      return {
        fieldId: correction.fieldId,
        name: correction.name,
        label: correction.label,
        itemIndex: correction.itemIndex ?? 0,
        before: correction.before ?? '',
        after: correction.after ?? '',
        provenance: {
          textSource: document.textSource,
          ...(item?.evidenceId ? { evidenceId: item.evidenceId } : {}),
          confidence: item?.confidence ?? 0
        }
      }
    })

  const corrections = Object.fromEntries(changes.map((change) => [change.name, change.after]))
  changes.push(...itemChanges)
  const decision: ReviewDecision =
    action === 'DISCARD' ? 'REJECT' : changes.length > 0 ? 'CORRECT' : 'APPROVE'

  return {
    decision,
    ...(changes.length > 0
      ? { ...(Object.keys(corrections).length > 0 ? { corrections } : {}), changes }
      : {}),
    ...(note ? { note } : {})
  }
}

/**
 * Registra l'esito scelto dal revisore. I campi sono già a database — ogni modifica li
 * scrive nel momento in cui avviene — quindi qui si fissano solo lo stato (dentro o fuori
 * dal dataset), il momento della decisione, la nota e la riga di timeline che racconta
 * cosa è cambiato.
 *
 * La nota finisce sia nella timeline, che la racconta, sia su una colonna sua, da cui
 * l'export la rilegge: il testo della timeline è per gli occhi e non è un formato.
 *
 * Nella stessa transazione una revisione salvata diventa eventi per il learner
 * (`learnFromReview`), e la riga di timeline dice se e quanto è stato registrato.
 */
export function submitReview(
  repo: Repository,
  input: {
    documentId: string
    action: ReviewAction
    note?: string | undefined
    now?: Date
    /** L'account che salva; senza, la revisione non si registra per il learner. */
    actor?: string | null
  }
): ReviewDocument {
  const document = repo.getReviewDocument(input.documentId)
  if (!document) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')

  const payload = buildReviewPayload(document, input.action, input.note)
  const { title, detail } = describeReview(payload)
  const at = (input.now ?? new Date()).toISOString()

  repo.transaction(() => {
    const learned = learnFromReview(repo, {
      document,
      action: input.action,
      at,
      actor: input.actor ?? null
    })
    repo.documents.setReviewOutcome(
      input.documentId,
      statusForAction(input.action),
      at,
      payload.note ?? null
    )
    repo.events.add(input.documentId, title, learned ? `${detail} ${learned}` : detail, at)
  })

  return repo.getReviewDocument(input.documentId)!
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
            `${change.label}${change.itemIndex !== undefined ? ` riga ${change.itemIndex + 1}` : ''} «${change.before || '(vuoto)'}» → «${change.after || '(vuoto)'}»`
        )
        .join('; ')
    )
  }

  if (payload.note) parts.push(`Nota: ${payload.note}`)
  return { title, detail: parts.join(' ') }
}
