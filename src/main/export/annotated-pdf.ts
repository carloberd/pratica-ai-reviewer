import { readFile, writeFile } from 'node:fs/promises'
import type { Annotation } from '@shared/types'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { ReviewerError } from '../errors'

/**
 * Esporta una copia del PDF con sopra le annotazioni (D3: una copia, il file in cache
 * resta intatto).
 *
 * Le annotazioni sono salvate in unità di pagina pdf.js a scala 1 con origine in alto
 * a sinistra; pdf-lib disegna con l'origine in basso a sinistra, quindi la y va
 * ribaltata rispetto all'altezza della pagina.
 *
 * Il testo delle note non sta nel riquadro: ogni annotazione riceve un numero e in
 * fondo al documento viene aggiunta una pagina che li elenca per esteso.
 */
export async function exportAnnotatedPdf(
  sourcePath: string,
  annotations: Annotation[],
  filename: string
): Promise<Uint8Array> {
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(await readFile(sourcePath))
  } catch (error) {
    throw new ReviewerError(
      'EXTRACTION_FAILED',
      `Il PDF non è leggibile: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pages = pdf.getPages()

  const ordered = [...annotations].sort((a, b) =>
    a.page === b.page ? a.createdAt.localeCompare(b.createdAt) : a.page - b.page
  )

  ordered.forEach((annotation, index) => {
    const page = pages[annotation.page - 1]
    if (!page) return

    const { height } = page.getSize()
    const { x, y, w, h } = annotation.bbox
    const colour = annotation.kind === 'note' ? rgb(0.25, 0.44, 0.82) : rgb(0.85, 0.61, 0.09)

    page.drawRectangle({
      x,
      y: height - y - h,
      width: w,
      height: h,
      color: colour,
      opacity: 0.18,
      borderColor: colour,
      borderWidth: 1,
      borderOpacity: 0.8
    })

    const label = String(index + 1)
    page.drawRectangle({
      x: x - 14,
      y: height - y - 12,
      width: 13,
      height: 13,
      color: colour,
      opacity: 0.9
    })
    page.drawText(label, {
      x: x - 14 + (label.length > 1 ? 1.5 : 4.5),
      y: height - y - 9,
      size: 8,
      font: bold,
      color: rgb(1, 1, 1)
    })
  })

  const legend = pdf.addPage([595, 842])
  let cursor = 780
  legend.drawText('Annotazioni', { x: 56, y: cursor, size: 16, font: bold })
  cursor -= 22
  legend.drawText(filename, { x: 56, y: cursor, size: 10, font, color: rgb(0.45, 0.5, 0.54) })
  cursor -= 28

  if (ordered.length === 0) {
    legend.drawText('Nessuna annotazione su questo documento.', {
      x: 56,
      y: cursor,
      size: 11,
      font,
      color: rgb(0.45, 0.5, 0.54)
    })
  }

  ordered.forEach((annotation, index) => {
    if (cursor < 70) {
      cursor = 780
      pdf.addPage([595, 842])
    }
    const target = pdf.getPages().at(-1)!
    const kind = annotation.kind === 'note' ? 'Nota' : 'Evidenziazione'
    target.drawText(`${index + 1}. ${kind} · pagina ${annotation.page}`, {
      x: 56,
      y: cursor,
      size: 11,
      font: bold
    })
    cursor -= 16

    for (const line of wrap(annotation.note ?? '—', 92)) {
      target.drawText(line, { x: 68, y: cursor, size: 10, font, color: rgb(0.18, 0.22, 0.25) })
      cursor -= 14
    }
    cursor -= 8
  })

  return pdf.save()
}

/** pdf-lib non manda a capo da solo: il testo lungo va spezzato a mano. */
function wrap(text: string, columns: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current.length + word.length + 1 > columns) {
      if (current) lines.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['—']
}

export async function writeAnnotatedPdf(destination: string, bytes: Uint8Array): Promise<void> {
  await writeFile(destination, bytes)
}
