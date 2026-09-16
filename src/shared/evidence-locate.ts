import type { BoundingBox, DocumentLocation, EvidenceItem } from './types'

/**
 * Dove portare il revisore quando clicca un'evidenza. Arriva da un campo, da una riga di
 * un campo ripetuto o da un indizio del classificatore: al visualizzatore basta sapere
 * pagina, testo e, se c'è, il rettangolo.
 */
export interface EvidenceTarget {
  page: number
  /** Verbatim dal documento. */
  text: string
  bbox?: BoundingBox
  /** Presente quando il bersaglio è un'evidenza salvata, per evidenziarla in elenco. */
  evidenceId?: string
}

export function targetOfEvidence(evidence: EvidenceItem): EvidenceTarget {
  return {
    page: evidence.page,
    text: evidence.text,
    evidenceId: evidence.id,
    ...(evidence.bbox ? { bbox: evidence.bbox } : {})
  }
}

export function targetOfLocation(location: DocumentLocation): EvidenceTarget {
  return {
    page: location.page,
    text: location.text,
    ...(location.bbox ? { bbox: location.bbox } : {})
  }
}

/**
 * La riga da cercare: un'evidenza letta su due righe (etichetta a fine riga, valore sotto)
 * è salvata come «riga\nriga»; la prima basta a ritrovare il punto.
 */
export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Posizione della riga di evidenza dentro un testo lungo (il DOCX), tollerando spazi e a
 * capo diversi da quelli salvati. Prima il confronto esatto, poi senza maiuscole.
 */
export function findTextRange(
  haystack: string,
  evidenceText: string
): { start: number; end: number } | null {
  const tokens = firstLine(evidenceText).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const source = tokens.map(escapeRegExp).join('\\s+')
  for (const flags of ['', 'i']) {
    const match = new RegExp(source, flags).exec(haystack)
    if (match) return { start: match.index, end: match.index + match[0].length }
  }
  return null
}

/**
 * Quali frammenti del text layer di pdf.js compongono la riga di evidenza. Serve quando
 * l'evidenza non ha coordinate ma la pagina ha testo: i frammenti trovati danno il
 * rettangolo da evidenziare. Il confronto ignora gli spazi, perché pdf.js li distribuisce
 * fra i frammenti in modo diverso da come la riga è stata ricomposta in estrazione.
 * Ritorna gli indici del primo e dell'ultimo frammento, o `null`.
 */
export function matchSpans(spanTexts: string[], evidenceText: string): [number, number] | null {
  const needle = firstLine(evidenceText).replace(/\s+/g, '')
  if (!needle) return null

  let joined = ''
  const owner: number[] = []
  spanTexts.forEach((text, index) => {
    const compact = text.replace(/\s+/g, '')
    joined += compact
    for (let i = 0; i < compact.length; i += 1) owner.push(index)
  })

  let start = joined.indexOf(needle)
  if (start === -1) start = joined.toLowerCase().indexOf(needle.toLowerCase())
  if (start === -1) return null
  return [owner[start]!, owner[start + needle.length - 1]!]
}

/** Il rettangolo che contiene tutti i rettangoli dati. */
export function unionRect(boxes: BoundingBox[]): BoundingBox | null {
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.w))
  const bottom = Math.max(...boxes.map((box) => box.y + box.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}
