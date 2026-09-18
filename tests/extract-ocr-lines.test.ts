import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locatePick } from '@shared/pick-locate'
import { afterAll, describe, expect, it } from 'vitest'
import type { OcrService } from '../src/main/extract/ocr'
import { createOcrEngine } from '../src/main/extract/ocr-engine'
import { extractText } from '../src/main/extract/text'
import { fixture, TESSDATA_DIR } from './helpers/registry'

/**
 * Le righe di una pagina letta con OCR, con le coordinate.
 *
 * OCR reale, in-process: stesso motore del worker, stessi modelli versionati nel repo.
 * Il PDF è una scansione vera (`durc-scansionato.pdf`), cioè una pagina fatta di una sola
 * immagine: è il caso su cui il learner era cieco.
 */
const cachePath = mkdtempSync(join(tmpdir(), 'reviewer-ocr-lines-'))
const engine = createOcrEngine({ tessdataDir: TESSDATA_DIR, cachePath })
const ocr: OcrService = {
  recognize: async (pdfPath, pages) =>
    new Map((await engine.recognizePdfPages(pdfPath, pages)).map((page) => [page.page, page])),
  recognizeImage: (image) => engine.recognizeImage(image),
  dispose: () => engine.dispose()
}

afterAll(async () => {
  await engine.dispose()
  rmSync(cachePath, { recursive: true, force: true })
})

/** A4: le coordinate delle righe devono cadere qui dentro. */
const WIDTH = 595
const HEIGHT = 842

describe('OCR con le coordinate delle righe', () => {
  it('legge la scansione e dà a ogni riga il suo riquadro sulla pagina', async () => {
    const read = await extractText({
      filePath: fixture('durc-scansionato.pdf'),
      mime: 'application/pdf',
      ocr
    })

    expect(read.source).toBe('OCR')
    const lines = read.pages[0]!.lines
    expect(lines.length).toBeGreaterThan(3)
    expect(lines.every((line) => line.bbox)).toBe(true)

    for (const { bbox } of lines) {
      expect(bbox!.x).toBeGreaterThanOrEqual(0)
      expect(bbox!.y).toBeGreaterThanOrEqual(0)
      expect(bbox!.x + bbox!.w).toBeLessThanOrEqual(WIDTH)
      expect(bbox!.y + bbox!.h).toBeLessThanOrEqual(HEIGHT)
    }

    // L'origine è in alto a sinistra, come per le righe del text layer: la prima riga
    // letta sta più in alto dell'ultima.
    expect(lines[0]!.bbox!.y).toBeLessThan(lines.at(-1)!.bbox!.y)
  }, 180_000)

  it('una selezione ad area si ritrova per sovrapposizione, come sul testo nativo', async () => {
    const read = await extractText({
      filePath: fixture('durc-scansionato.pdf'),
      mime: 'application/pdf',
      ocr
    })
    const lines = read.pages[0]!.lines
    const index = lines.findIndex((line) => line.text.includes('Emittente'))
    expect(index).toBeGreaterThanOrEqual(0)

    // Il riquadro che il revisore disegnerebbe attorno a quella riga: il testo del ritaglio
    // non coincide con quello della pagina — sono due letture diverse — ma le righe sì.
    const box = lines[index]!.bbox!
    const located = locatePick(lines, {
      method: 'AREA_OCR',
      page: 1,
      text: 'lettura del ritaglio, diversa da quella della pagina',
      bbox: { x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 }
    })

    expect(located).toMatchObject({ lineStart: index, lineEnd: index })
  }, 180_000)
})
