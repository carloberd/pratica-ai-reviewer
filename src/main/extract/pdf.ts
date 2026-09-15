import { readFile } from 'node:fs/promises'
import type { BoundingBox } from '@shared/types'
import { ReviewerError } from '../errors'
import type { ExtractedPage, TextLine } from './types'

/**
 * pdf.js v5 è solo ESM: nel bundle CJS del main l'import dinamico resta tale e viene
 * risolto a runtime. Il modulo viene caricato una volta sola.
 */
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<PdfjsModule> | null = null

export async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsPromise
}

interface TextItemLike {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

/** Due frammenti appartengono alla stessa riga se le baseline distano meno di questo. */
const LINE_TOLERANCE = 2.5

function unionBox(boxes: BoundingBox[]): BoundingBox | undefined {
  if (boxes.length === 0) return undefined
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.w)
    bottom = Math.max(bottom, box.y + box.h)
  }
  return {
    x: Math.round(left * 100) / 100,
    y: Math.round(top * 100) / 100,
    w: Math.round((right - left) * 100) / 100,
    h: Math.round((bottom - top) * 100) / 100
  }
}

/**
 * Raggruppa i frammenti di pdf.js in righe.
 *
 * Il text layer di un PDF non ha righe: ha pezzi di testo posizionati. Senza questo
 * raggruppamento l'evidenza sarebbe un frammento isolato («114/2026») invece della
 * riga leggibile da cui viene («Fattura n. 114/2026 del 08/09/2026»).
 */
export function groupItemsIntoLines(
  items: TextItemLike[],
  toViewport: (x: number, y: number) => [number, number]
): TextLine[] {
  interface Draft {
    baseline: number
    pieces: Array<{ x: number; text: string; box: BoundingBox | null }>
  }

  const drafts: Draft[] = []

  for (const item of items) {
    if (typeof item.str !== 'string' || item.str.length === 0) continue
    const e = item.transform[4] ?? 0
    const f = item.transform[5] ?? 0
    const [vx, vy] = toViewport(e, f)
    const height = item.height || 0
    const box: BoundingBox | null =
      item.width > 0 && height > 0 ? { x: vx, y: vy - height, w: item.width, h: height } : null

    const draft = drafts.find((candidate) => Math.abs(candidate.baseline - vy) <= LINE_TOLERANCE)
    if (draft) {
      draft.pieces.push({ x: vx, text: item.str, box })
    } else {
      drafts.push({ baseline: vy, pieces: [{ x: vx, text: item.str, box }] })
    }
  }

  return drafts
    .sort((a, b) => a.baseline - b.baseline)
    .map((draft) => {
      const pieces = draft.pieces.sort((a, b) => a.x - b.x)
      const text = pieces
        .map((piece) => piece.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      const bbox = unionBox(pieces.map((piece) => piece.box).filter((box) => box !== null))
      return bbox ? { text, bbox } : { text }
    })
    .filter((line) => line.text.length > 0)
}

export async function extractPdfPages(filePath: string): Promise<ExtractedPage[]> {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(await readFile(filePath))

  let document: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>
  try {
    document = await pdfjs.getDocument({
      data,
      // Nessuna risorsa remota: font di sistema e font embedded restano fuori,
      // qui interessa solo il text layer.
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0
    }).promise
  } catch (error) {
    throw new ReviewerError(
      'EXTRACTION_FAILED',
      `Il PDF non è leggibile: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const pages: ExtractedPage[] = []
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      // `items` mescola frammenti di testo e marcatori di struttura: qui servono
      // solo i primi.
      const items = content.items.filter(
        (item) => 'str' in item && 'transform' in item
      ) as unknown as TextItemLike[]
      const lines = groupItemsIntoLines(items, (x, y) => {
        const [vx, vy] = viewport.convertToViewportPoint(x, y)
        return [vx ?? 0, vy ?? 0]
      })
      pages.push({ page: pageNumber, text: lines.map((line) => line.text).join('\n'), lines })
      page.cleanup()
    }
  } finally {
    await document.destroy()
  }

  return pages
}
