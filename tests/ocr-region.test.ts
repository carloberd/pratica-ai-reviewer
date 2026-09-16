import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { afterAll, describe, expect, it } from 'vitest'
import { createOcrEngine } from '../src/main/extract/ocr-engine'
import { ocrRegionSchema } from '../src/main/ipc/schemas'
import { TESSDATA_DIR } from './helpers/registry'

const cachePath = mkdtempSync(join(tmpdir(), 'reviewer-ocr-region-'))
const engine = createOcrEngine({ tessdataDir: TESSDATA_DIR, cachePath })

afterAll(async () => {
  await engine.dispose()
  rmSync(cachePath, { recursive: true, force: true })
})

/** Ritaglio come quello che manda il renderer: fondo bianco e una riga di testo. */
function crop(text: string): Uint8Array {
  const canvas = createCanvas(720, 160)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 720, 160)
  context.fillStyle = '#000000'
  context.font = '64px Helvetica'
  context.fillText(text, 20, 100)
  return new Uint8Array(canvas.toBuffer('image/png'))
}

describe('OCR di un ritaglio di pagina', () => {
  it('legge il testo evidenziato sulla scansione', async () => {
    const text = await engine.recognizeImage(crop('IT03645870962'))
    expect(text.replace(/\s+/g, '')).toContain('IT03645870962')
  })
})

describe('schema del canale ocr:region', () => {
  it('accetta i byte dell immagine, come Uint8Array o ArrayBuffer', () => {
    expect(ocrRegionSchema.safeParse({ image: new Uint8Array([1, 2, 3]) }).success).toBe(true)
    expect(ocrRegionSchema.safeParse({ image: new ArrayBuffer(8) }).success).toBe(true)
  })

  it('rifiuta un ritaglio vuoto, uno troppo grande e un input che non è binario', () => {
    expect(ocrRegionSchema.safeParse({ image: new Uint8Array(0) }).success).toBe(false)
    expect(ocrRegionSchema.safeParse({ image: new Uint8Array(17 * 1024 * 1024) }).success).toBe(
      false
    )
    expect(ocrRegionSchema.safeParse({ image: 'non binario' }).success).toBe(false)
  })
})
