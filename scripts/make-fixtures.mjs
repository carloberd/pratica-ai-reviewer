/**
 * Genera le fixture di `tests/fixtures/`.
 *
 * Le fixture sono versionate: i test non devono dipendere da questo script, che
 * serve solo a documentare (e a rifare) come sono state prodotte.
 *
 *   node scripts/make-fixtures.mjs
 *
 * Richiede `zip` (presente su macOS e Linux) per costruire il DOCX.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'tests', 'fixtures')
mkdirSync(fixtures, { recursive: true })

const FATTURA_LINES = [
  'ALFA S.R.L.',
  'Via Roma 12 - 40100 Bologna',
  '',
  'FATTURA n. 114/2026 del 08/09/2026',
  '',
  'Emittente: Alfa S.r.l.',
  'Destinatario: Beta Costruzioni S.p.A.',
  'Partita IVA: 01234567890',
  'Valuta: EUR',
  '',
  'Descrizione                         Imponibile',
  'Fornitura materiali edili           70.836,07',
  '',
  'Totale imponibile  EUR 70.836,07',
  'IVA 22%            EUR 15.583,93',
  'Totale documento   EUR 86.420,00',
  '',
  'Pagamento a 30 giorni data fattura.'
]

const SCANSIONE_LINES = [
  'PAYROLL CONTRIBUTIONS',
  '',
  'DURC',
  'Documento Unico di Regolarita Contributiva',
  '',
  'Emittente: INPS - Sede di Bologna',
  'Destinatario: Beta Costruzioni S.p.A.',
  'Protocollo n. 2026/554321',
  '',
  'Data di emissione: 01/09/2026',
  'La presente attestazione ha validita 120 giorni.'
]

const CONTRATTO_LINES = [
  'CONTRATTO CONSULENZA',
  '',
  'Documento n. CC-2026-018',
  'Data di emissione: 15/09/2026',
  'Emittente: Gamma Consulting S.r.l.',
  'Destinatario: Alfa S.r.l.',
  '',
  "Oggetto: attivita di consulenza organizzativa per l'anno 2026.",
  'Il corrispettivo pattuito ammonta a EUR 24.000,00 oltre IVA di legge.'
]

/** Documento che non corrisponde a nessun alias del registry: resta da classificare. */
const IGNOTO_LINES = [
  'Promemoria interno',
  '',
  'Riepilogo delle spese sostenute nel mese',
  'Importo complessivo EUR 1.250,00',
  'Data: 12/09/2026',
  '',
  'Da archiviare a cura della segreteria.'
]

/** PDF con text layer nativo: pdf.js legge il testo senza OCR. */
async function makeTextPdf(lines, outfile) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([595, 842])
  let y = 780
  for (const line of lines) {
    if (line) page.drawText(line, { x: 56, y, size: 11, font, color: rgb(0.05, 0.06, 0.08) })
    y -= 20
  }
  writeFileSync(outfile, await pdf.save())
}

/** PDF di sola immagine: nessun text layer, quindi obbligatoriamente OCR. */
async function makeScannedPdf(lines, outfile) {
  const width = 1240
  const height = 1754
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#000000'
  let y = 150
  for (const line of lines) {
    if (line) {
      context.font =
        line === line.toUpperCase() && line.length < 40 ? 'bold 44px Helvetica' : '34px Helvetica'
      context.fillText(line, 110, y)
    }
    y += 62
  }

  const pdf = await PDFDocument.create()
  const png = await pdf.embedPng(canvas.toBuffer('image/png'))
  const page = pdf.addPage([595, 842])
  page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 })
  writeFileSync(outfile, await pdf.save())
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** DOCX minimo ma valido, leggibile da mammoth. */
function makeDocx(lines, outfile) {
  const staging = mkdtempSync(join(tmpdir(), 'reviewer-docx-'))
  try {
    mkdirSync(join(staging, '_rels'))
    mkdirSync(join(staging, 'word'))

    writeFileSync(
      join(staging, '[Content_Types].xml'),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    )

    writeFileSync(
      join(staging, '_rels', '.rels'),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    )

    const paragraphs = lines
      .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
      .join('')

    writeFileSync(
      join(staging, 'word', 'document.xml'),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs}</w:body></w:document>`
    )

    rmSync(outfile, { force: true })
    execFileSync('zip', ['-q', '-r', '-X', outfile, '.'], { cwd: staging })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

await makeTextPdf(FATTURA_LINES, join(fixtures, 'fattura-nativa.pdf'))
await makeScannedPdf(SCANSIONE_LINES, join(fixtures, 'durc-scansionato.pdf'))
await makeTextPdf(IGNOTO_LINES, join(fixtures, 'promemoria-ignoto.pdf'))
makeDocx(CONTRATTO_LINES, join(fixtures, 'contratto-consulenza.docx'))

console.log('fixture generate in tests/fixtures/')
