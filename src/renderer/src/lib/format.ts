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

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export function mimeLabel(mime: string): string {
  if (mime === 'application/pdf') return 'PDF'
  if (mime === DOCX_MIME) return 'DOCX'
  return mime
}

/** Dimensioni leggibili: il punto è capire quanto disco costa, non il byte esatto. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}
