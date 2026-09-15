import { ReviewerError } from '../errors'
import type { ExtractedPage } from './types'

/**
 * D4: dei DOCX si estrae solo il testo, con mammoth. In v1 non c'è resa di pagina,
 * quindi non ci sono coordinate e non ci sono annotazioni: tutto il documento è
 * modellato come una pagina sola.
 */
export async function extractDocxPages(filePath: string): Promise<ExtractedPage[]> {
  let raw: string
  try {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ path: filePath })
    raw = result.value
  } catch (error) {
    throw new ReviewerError(
      'EXTRACTION_FAILED',
      `Il DOCX non è leggibile: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)

  return [{ page: 1, text: lines.join('\n'), lines: lines.map((text) => ({ text })) }]
}
