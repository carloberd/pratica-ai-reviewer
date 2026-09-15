import type { ConfidenceBand, QueueStatus, TextSource } from '@shared/types'

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

const dateTimeFormat = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return dateTimeFormat.format(date)
}

export const STATUS_LABELS: Record<QueueStatus, string> = {
  NEEDS_REVIEW: 'Da verificare',
  APPROVED: 'Approvato',
  REJECTED: 'Rifiutato'
}

export const BAND_LABELS: Record<ConfidenceBand, string> = {
  HIGH: 'Alta',
  MEDIUM: 'Media',
  LOW: 'Bassa'
}

export const TEXT_SOURCE_LABELS: Record<TextSource, string> = {
  NATIVE_TEXT: 'Testo nativo',
  OCR: 'OCR (tesseract)',
  DOCX: 'Testo DOCX'
}

export function textSourceLabel(source: TextSource | null): string {
  return source ? TEXT_SOURCE_LABELS[source] : '—'
}

export function typeLabel(documentType: string | null, label: string | null): string {
  if (!documentType) return 'Da assegnare'
  return label ? `${label} (${documentType})` : documentType
}
