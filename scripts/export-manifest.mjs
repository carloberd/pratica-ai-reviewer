/**
 * Riduce un export del Reviewer a un manifest senza valori.
 *
 *   node scripts/export-manifest.mjs docs/exports/2026-09-18
 *   node scripts/export-manifest.mjs <cartella> -o docs/dataset/2026-09-18-manifest.json
 *
 * Gli export contengono i documenti dei clienti: valori letti, testo dell'evidenza,
 * nomi dei file. Nel repository non ci entrano (`docs/exports/` è in `.gitignore`).
 * Quello che resta versionato è questo manifest: hash dei file di origine, versioni,
 * classi e conteggi — abbastanza per sapere su quali dati è stata misurata una cosa,
 * niente che riproduca il contenuto di un documento.
 *
 * Il manifest è generato, non scritto a mano: si rigenera quando arriva un export
 * nuovo, e il confronto degli sha-256 dice se è lo stesso export di prima.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const MANIFEST_FORMAT = 'praticaai-reviewer/dataset-manifest'
const MANIFEST_VERSION = '1.0.0'

/** Un valore che somiglia a un IBAN o a un codice fiscale non deve uscire da qui. */
const LEAK_PATTERNS = [
  { name: 'IBAN', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/ },
  { name: 'codice fiscale', re: /\b[A-Z]{6}\d{2}[ABCDEHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/ }
]

const args = process.argv.slice(2)
const outIndex = args.findIndex((a) => a === '-o' || a === '--out')
const outPath = outIndex === -1 ? null : args[outIndex + 1]
const dir = args.filter((_, i) => outIndex === -1 || (i !== outIndex && i !== outIndex + 1))[0]

if (!dir) {
  console.error('uso: node scripts/export-manifest.mjs <cartella-export> [-o <file>]')
  process.exit(2)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const tally = (values) => {
  const out = {}
  for (const v of values) {
    const key = v === null || v === undefined ? 'null' : String(v)
    out[key] = (out[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json') || f.endsWith('.xlsx'))
  .sort()

const sources = files.map((f) => {
  const path = join(dir, f)
  return { file: basename(f), bytes: statSync(path).size, sha256: sha256(readFileSync(path)) }
})

const readJson = (suffix) => {
  const f = files.find((x) => x.includes(suffix) && x.endsWith('.json'))
  return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null
}

const dataset = readJson('dataset')
const rules = readJson('regole-apprese') ?? readJson('learned-rules')

if (!dataset) {
  console.error(`in ${dir} non c'è un export del dataset`)
  process.exit(1)
}

const documents = dataset.documents ?? []
const classes = {}
for (const doc of documents) {
  const id = doc.documentType?.id ?? 'SENZA_TIPO'
  if (!classes[id]) {
    classes[id] = {
      documents: 0,
      reviewed: 0,
      discarded: 0,
      fields: 0,
      fieldsValued: 0,
      corrections: 0
    }
  }
  const cls = classes[id]
  cls.documents += 1
  if (doc.status === 'REVIEWED') cls.reviewed += 1
  if (doc.status === 'DISCARDED') cls.discarded += 1
  cls.fields += doc.fields?.length ?? 0
  cls.fieldsValued += (doc.fields ?? []).filter((f) => hasValue(f)).length
  cls.corrections += doc.corrections?.length ?? 0
}

function hasValue(field) {
  if (field.cardinality === 'many') return (field.items?.length ?? 0) > 0
  return field.value !== null && field.value !== undefined && field.value !== ''
}

const allFields = documents.flatMap((d) => d.fields ?? [])
const allCorrections = documents.flatMap((d) => d.corrections ?? [])
const typed = documents.filter((d) => d.documentType?.id)

const manifest = {
  format: MANIFEST_FORMAT,
  formatVersion: MANIFEST_VERSION,
  generatedAt: new Date().toISOString(),
  nota: "Manifest senza valori, generato da scripts/export-manifest.mjs. Non contiene valori letti dai documenti, testo dell'evidenza, nomi dei file né identificativi Drive.",
  sources,
  export: dataset.manifest ?? null,
  corpus: {
    documents: documents.length,
    byStatus: tally(documents.map((d) => d.status)),
    byTextSource: tally(documents.map((d) => d.textSource)),
    byMime: tally(documents.map((d) => d.mime)),
    byExtractionStatus: tally(documents.map((d) => d.extraction?.status)),
    conContentSha256: documents.filter((d) => d.contentSha256).length,
    contentSha256: documents
      .map((d) => d.contentSha256)
      .filter(Boolean)
      .sort()
  },
  classification: {
    classi: new Set(typed.map((d) => d.documentType.id)).size,
    conTipo: typed.length,
    conProposta: typed.filter((d) => d.documentType.proposed).length,
    proposteCorrette: typed.filter((d) => d.documentType.proposed && !d.documentType.corrected)
      .length,
    byChosenBy: tally(typed.map((d) => d.documentType.chosenBy))
  },
  classes: Object.fromEntries(
    Object.entries(classes).sort((a, b) => b[1].documents - a[1].documents)
  ),
  fields: {
    total: allFields.length,
    valued: allFields.filter(hasValue).length,
    byRole: tally(allFields.map((f) => f.role)),
    byOrigin: tally(allFields.map((f) => f.origin)),
    byCardinality: tally(allFields.map((f) => f.cardinality))
  },
  corrections: {
    total: allCorrections.length,
    byKind: tally(allCorrections.map((c) => c.kind))
  },
  learnedRules: rules
    ? {
        export: rules.manifest ?? null,
        rules: rules.rules?.length ?? 0,
        events: rules.events?.length ?? 0,
        byStatus: tally((rules.rules ?? []).map((r) => r.status)),
        byScope: tally((rules.rules ?? []).map((r) => r.scope)),
        byKind: tally((rules.rules ?? []).map((r) => r.kind))
      }
    : null
}

const serialized = `${JSON.stringify(manifest, null, 2)}\n`

for (const { name, re } of LEAK_PATTERNS) {
  const hit = serialized.match(re)
  if (hit) {
    console.error(`il manifest conterrebbe un ${name}: non lo scrivo`)
    process.exit(1)
  }
}

if (outPath) {
  writeFileSync(outPath, serialized)
  console.log(`${outPath}: ${documents.length} documenti, ${manifest.classification.classi} classi`)
} else {
  process.stdout.write(serialized)
}
