import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import type { ExtractionResultV2 } from '@shared/extraction-v2'
import type { LearningRule } from '@shared/local-learning'
import { describe, expect, it } from 'vitest'
import { DOCX_MIME, PDF_MIME } from '../src/main/drive/client'
import type { OcrService } from '../src/main/extract/ocr'
import { createOcrEngine } from '../src/main/extract/ocr-engine'
import { extractText } from '../src/main/extract/text'
import { extractFactsV2 } from '../src/main/extract/v2/fact-reader'
import { learnedLabelsFor } from '../src/main/learning-anchors'
import { templateMemoryFor } from '../src/main/learning-templates'
import {
  EXTRACTION_ENGINE_V2_VERSION,
  firstPageFingerprint,
  firstPageTemplateSignature
} from '../src/main/pipeline'
import { matchDocumentTypeV2 } from '../src/main/registry/v2/classify-v2'
import {
  addClassification,
  addReviewCounts,
  addScore,
  emptyClassificationTally,
  emptyReviewCounts,
  emptyScore,
  fieldOutcomes,
  filledDespiteAbsent,
  type LearnedRuleSet,
  learnedRulesFromBundle,
  outsideProfile,
  parseManifest,
  reviewCounts,
  summarizeClassification,
  summarizeScore,
  tally,
  valuesOf
} from './helpers/pilot-benchmark'
import {
  TESSDATA_DIR,
  testClassifierConfigV2,
  testRegistry,
  testRegistryV2
} from './helpers/registry'

/**
 * Benchmark su un corpus reale: classificazione ed estrazione misurate contro un manifest
 * annotato a mano. Il protocollo per una misura valida sta nel README («Misurare su un
 * corpus reale»); il formato del manifest in `docs/pilota_reale_todo.md`.
 *
 * Documenti, manifest e risultati non entrano mai nel repository: tutto arriva da variabili
 * d'ambiente, e senza le prime due il test è saltato.
 *
 * - `PRACTICAAI_PILOT_CORPUS`: la cartella dei documenti;
 * - `PRACTICAAI_PILOT_MANIFEST`: il manifest JSON, coi percorsi relativi alla cartella;
 * - `PRACTICAAI_PILOT_OUTPUT`: dove scrivere il report, facoltativo. Contiene nomi, valori
 *   ed evidenze dei documenti: va tenuto fuori dal repository;
 * - `PRACTICAAI_PILOT_LEARNED_RULES`: un file «Esporta le regole», facoltativo. Senza, la
 *   misura è `BASELINE` (solo registry); con, è `FROZEN`: le regole attive del file si
 *   applicano come nell'app, e nessuna se ne impara.
 *
 * Ogni documento si misura due volte. **End-to-end**: col tipo che il classificatore ha
 * assegnato, cioè quello che chi annota si troverebbe precompilato — anche quando il tipo è
 * sbagliato, perché i valori di un profilo sbagliato finiscono lo stesso davanti a lui.
 * **Oracle**: col tipo vero del manifest, per misurare l'estrazione da sola.
 */
const corpusDirectory = process.env.PRACTICAAI_PILOT_CORPUS
const manifestPath = process.env.PRACTICAAI_PILOT_MANIFEST
const outputPath = process.env.PRACTICAAI_PILOT_OUTPUT
const learnedRulesPath = process.env.PRACTICAAI_PILOT_LEARNED_RULES
const enabled = Boolean(corpusDirectory && manifestPath)

/** Un corpus con molte scansioni passa dall'OCR pagina per pagina. */
const TIMEOUT_MS = 60 * 60 * 1000

function mimeOf(filename: string): string | null {
  const extension = extname(filename).toLowerCase()
  if (extension === '.pdf') return PDF_MIME
  if (extension === '.docx') return DOCX_MIME
  return null
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Il commit misurato, e se c'erano modifiche non committate: la misura lo dichiara. */
function codeVersion(): { commit: string | null; dirty: boolean | null } {
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: __dirname, encoding: 'utf8' }).trim()
    return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '' }
  } catch {
    return { commit: null, dirty: null }
  }
}

/** Le regole che hanno lavorato su questo documento: memoria del modulo ed etichette. */
function rulesUsed(result: ExtractionResultV2 | null, templateRuleIds: string[]): string[] {
  const fromEvidence = (result?.facts ?? []).flatMap((fact) =>
    fact.evidence.flatMap((item) => (item.ruleId ? [item.ruleId] : []))
  )
  return [...new Set([...templateRuleIds, ...fromEvidence])].sort()
}

describe('benchmark su corpus reale', () => {
  it('le variabili del corpus vanno date insieme', () => {
    // Una sola delle due è quasi certamente un errore di chi lancia: saltare in silenzio
    // farebbe credere di aver misurato.
    expect(Boolean(corpusDirectory)).toBe(Boolean(manifestPath))
  })
})

describe.skipIf(!enabled)('benchmark su corpus reale, col corpus', () => {
  it(
    'misura classificazione ed estrazione senza portare documenti o valori nel repository',
    async () => {
      const corpus = resolve(corpusDirectory!)
      const manifestFile = resolve(manifestPath!)
      expect(existsSync(corpus), `Cartella del corpus mancante: ${corpus}`).toBe(true)
      expect(existsSync(manifestFile), `Manifest mancante: ${manifestFile}`).toBe(true)
      const manifest = parseManifest(JSON.parse(readFileSync(manifestFile, 'utf8')))

      let learned: LearnedRuleSet | null = null
      let learnedSha256: string | null = null
      if (learnedRulesPath) {
        const file = resolve(learnedRulesPath)
        expect(existsSync(file), `Regole apprese mancanti: ${file}`).toBe(true)
        learned = learnedRulesFromBundle(JSON.parse(readFileSync(file, 'utf8')))
        learnedSha256 = sha256Of(file)
      }
      const rules: LearningRule[] = learned?.rules ?? []

      const registry = testRegistry()
      const registryV2 = testRegistryV2()
      const classifierConfig = testClassifierConfigV2()
      const specOf = (fieldId: string) => registryV2.field(fieldId)

      // Prima di elaborare: un tipo atteso che il motore non conosce è un errore del
      // manifest, e misurato darebbe solo campi mancanti.
      for (const document of manifest.documents) {
        if (document.documentType === null) continue
        expect(
          registryV2.profile(document.documentType),
          `Tipo senza profilo di estrazione: ${document.documentType} (${document.file})`
        ).not.toBeNull()
      }

      const cachePath = mkdtempSync(join(tmpdir(), 'reviewer-pilot-ocr-'))
      const engine = createOcrEngine({ tessdataDir: TESSDATA_DIR, cachePath })
      const ocr: OcrService = {
        recognize: async (pdfPath, pages) =>
          new Map(
            (await engine.recognizePdfPages(pdfPath, pages)).map((page) => [page.page, page])
          ),
        recognizeImage: (image) => engine.recognizeImage(image),
        dispose: () => engine.dispose()
      }

      const classification = emptyClassificationTally()
      const fields = { endToEnd: emptyScore(), oracleType: emptyScore() }
      const expectedAbsentFilled = { endToEnd: 0, oracleType: 0 }
      const review = { endToEnd: emptyReviewCounts(), oracleType: emptyReviewCounts() }
      const results = []

      try {
        for (const expected of manifest.documents) {
          const filePath = join(corpus, expected.file)
          const mime = mimeOf(expected.file)
          expect(mime, `Formato non gestito: ${expected.file}`).not.toBeNull()
          expect(existsSync(filePath), `File mancante: ${expected.file}`).toBe(true)
          expect(sha256Of(filePath), `Sha-256 diverso: ${expected.file}`).toBe(
            expected.sha256.toLowerCase()
          )

          const extracted = await extractText({ filePath, mime: mime!, ocr })
          // Come in `pipeline.ts`: memoria dei moduli per il classificatore, etichette
          // apprese per l'estrazione. In BASELINE le regole sono zero e non cambia niente.
          const fingerprint = firstPageFingerprint(extracted)
          const signature = firstPageTemplateSignature(extracted)
          const templateMemory = templateMemoryFor(rules, fingerprint, signature)

          const match = matchDocumentTypeV2({
            aliases: registry.aliases(),
            pages: extracted.pages.map((page) => page.text),
            filename: expected.file,
            config: classifierConfig,
            templateMemory
          })
          const assignedType = match.decision === 'ASSIGN' ? match.documentType : null
          const topType = match.candidates[0]?.documentType ?? null
          addClassification(classification, {
            expected: expected.documentType,
            assigned: assignedType,
            top: topType
          })

          const extract = (documentType: string | null): ExtractionResultV2 | null => {
            if (documentType === null || !registryV2.profile(documentType)) return null
            return extractFactsV2({
              documentType,
              pages: extracted.pages,
              registry: registryV2,
              ocrPages: extracted.ocrPages,
              learnedLabels: learnedLabelsFor(rules, documentType, fingerprint, signature)
            })
          }
          const oracleResult = extract(expected.documentType)
          const endToEndResult =
            assignedType === expected.documentType ? oracleResult : extract(assignedType)

          const measure = (result: ExtractionResultV2 | null, templateRuleIds: string[]) => {
            const values = valuesOf(result)
            const outcomes = fieldOutcomes(expected.fields, values, specOf)
            return {
              documentType: result?.documentType ?? null,
              score: tally(outcomes),
              outcomes,
              expectedAbsentFilled: filledDespiteAbsent(expected.expectedAbsent, values),
              outsideProfile: outsideProfile(expected.fields, result),
              review: reviewCounts(result),
              conflicts: result?.conflicts ?? [],
              rulesUsed: rulesUsed(result, templateRuleIds),
              values
            }
          }
          const templateRuleIds = templateMemory.map((memory) => memory.ruleId)
          const endToEnd = measure(endToEndResult, templateRuleIds)
          const oracleType = measure(oracleResult, [])

          addScore(fields.endToEnd, endToEnd.score)
          addScore(fields.oracleType, oracleType.score)
          expectedAbsentFilled.endToEnd += endToEnd.expectedAbsentFilled.length
          expectedAbsentFilled.oracleType += oracleType.expectedAbsentFilled.length
          addReviewCounts(review.endToEnd, endToEnd.review)
          addReviewCounts(review.oracleType, oracleType.review)

          results.push({
            file: expected.file,
            sha256: expected.sha256.toLowerCase(),
            textSource: extracted.source,
            ocrPages: extracted.ocrPages,
            expectedType: expected.documentType,
            assignedType,
            topType,
            classification: {
              decision: match.decision,
              reason: match.reason,
              confidence: match.confidence,
              margin: match.margin,
              candidates: match.candidates
            },
            endToEnd,
            oracleType
          })
        }
      } finally {
        await ocr.dispose()
        rmSync(cachePath, { recursive: true, force: true })
      }

      const report = {
        generatedAt: new Date().toISOString(),
        manifestVersion: manifest.version,
        documents: manifest.documents.length,
        code: {
          ...codeVersion(),
          extractionEngine: EXTRACTION_ENGINE_V2_VERSION,
          profiles: registryV2.schemaVersion()
        },
        learning: {
          mode: learned ? 'FROZEN' : 'BASELINE',
          rules: learned
            ? { sha256: learnedSha256, ...learned.manifest, activeRules: learned.rules.length }
            : null
        },
        classification: summarizeClassification(classification),
        fields: {
          endToEnd: summarizeScore(fields.endToEnd),
          oracleType: summarizeScore(fields.oracleType)
        },
        expectedAbsentFilled,
        review,
        results
      }

      if (outputPath) {
        writeFileSync(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      }
      expect(results).toHaveLength(manifest.documents.length)
    },
    TIMEOUT_MS
  )
})
