import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REGISTRY_DIR } from './helpers/registry'

const SCRIPT = resolve(__dirname, '../scripts/registry-audit.mjs')

interface AuditReport {
  invariants: Array<{ title: string; count: number; sample: string[] }>
  progress: Array<{ title: string; count: number; note: string }>
  conversion: {
    readyTypes: number
    blockedTypes: number
    rows: Array<{ id: string; template: string }>
  }
}

const directories: string[] = []

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Il registry vero, con le modifiche del caso scritte sopra, in una cartella usa e getta:
 * i controlli dello script si misurano su dati veri, non su un registry finto che non
 * assomiglia a niente.
 */
function auditOf(edit: (fields: Fields, map: Map) => void = () => {}): {
  status: number
  report: AuditReport
} {
  const fields = JSON.parse(readFileSync(join(REGISTRY_DIR, 'fields.json'), 'utf8')) as Fields
  const map = JSON.parse(readFileSync(join(REGISTRY_DIR, 'document_fields.json'), 'utf8')) as Map
  edit(fields, map)
  const dir = mkdtempSync(join(tmpdir(), 'registry-audit-'))
  directories.push(dir)
  writeFileSync(join(dir, 'fields.json'), JSON.stringify(fields))
  writeFileSync(join(dir, 'document_fields.json'), JSON.stringify(map))
  try {
    const out = execFileSync('node', [SCRIPT, dir, '--json'], { encoding: 'utf8' })
    return { status: 0, report: JSON.parse(out) as AuditReport }
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr?: string }
    if (typeof failure.stdout !== 'string') throw error
    return { status: failure.status, report: JSON.parse(failure.stdout) as AuditReport }
  }
}

interface Fields {
  fields: Record<string, Record<string, unknown>>
}
interface Map {
  document_types: Record<string, Record<string, string[]>>
}

const invariant = (report: AuditReport, fragment: string) =>
  report.invariants.find((check) => check.title.includes(fragment))!

const gap = (report: AuditReport, fragment: string) =>
  report.progress.find((item) => item.title.includes(fragment))!

describe('registry-audit: il registry com’è', () => {
  it('nessun invariante rotto, e la conversione costruisce le righe dalle colonne', () => {
    const { status, report } = auditOf()

    expect(status).toBe(0)
    expect(report.invariants.filter((check) => check.count > 0)).toEqual([])

    const entries = report.conversion.rows.find((row) => row.id === 'accounting.entries')
    // Le quattro colonne della descrizione, nei tipi NuExtract: è la conversione che senza
    // `columns` non si poteva scrivere.
    expect(entries?.template).toBe(
      '[{ "data": date-time, "descrizione": verbatim-string | string, ' +
        '"dare": number, "avere": number }]'
    )
    expect(report.conversion.readyTypes).toBeGreaterThan(report.conversion.blockedTypes)
  })

  it('i valori ammessi di un enum finiscono nel template, non una stringa libera', () => {
    const { report } = auditOf((fields) => {
      fields.fields['money.currency'] = { ...fields.fields['money.currency'], enum: ['EUR', 'USD'] }
    })

    const items = report.conversion.rows.find((row) => row.id === 'payment.items')
    expect(items?.template).toContain('"iban": verbatim-string')
    expect(gap(report, 'enum lasciati stringa libera').count).toBe(0)
  })
})

describe('registry-audit: gli invarianti nuovi colti in flagrante', () => {
  it('una colonna con un tipo che l’ontologia non ha fa uscire 1', () => {
    const { status, report } = auditOf((fields) => {
      const entries = fields.fields['accounting.entries'] as { columns: Array<{ type: string }> }
      entries.columns[0]!.type = 'timestamp'
    })

    expect(status).toBe(1)
    const check = invariant(report, 'tipo fuori dal vocabolario')
    expect(check.count).toBe(1)
    expect(check.sample[0]).toContain('accounting.entries.data')
  })

  it('due colonne con lo stesso id, o una senza etichetta, non passano', () => {
    const { status, report } = auditOf((fields) => {
      const entries = fields.fields['accounting.entries'] as {
        columns: Array<{ id: string; label_it: string }>
      }
      entries.columns[1]!.id = 'data'
      entries.columns[2]!.label_it = ''
    })

    expect(status).toBe(1)
    expect(invariant(report, 'stesso id dentro lo stesso campo').count).toBe(1)
    expect(invariant(report, 'colonne senza etichetta').count).toBe(1)
  })

  it('un campo derivato che chiede comunque una citazione non passa', () => {
    const { status, report } = auditOf((fields) => {
      fields.fields['document.direction']!.evidence_required = true
    })

    expect(status).toBe(1)
    expect(invariant(report, 'derivati che chiedono comunque una citazione').count).toBe(1)
  })

  it('un campo non si legge e si deriva insieme, e i derivati sono dichiarati tali', () => {
    const { status, report } = auditOf((_fields, map) => {
      map.document_types['accounting.fattura']!.required_fields!.push('document.direction')
      map.document_types['accounting.fattura']!.derived_fields!.push('money.net')
    })

    expect(status).toBe(1)
    expect(invariant(report, 'fra i derivati e insieme fra quelli da leggere').count).toBe(1)
    expect(invariant(report, 'non dichiarati «derived»').count).toBe(1)
  })

  it('un enum con un valore vuoto o ripetuto non passa', () => {
    const { status, report } = auditOf((fields) => {
      fields.fields['money.currency']!.enum = ['EUR', 'EUR', '']
    })

    expect(status).toBe(1)
    expect(invariant(report, 'enum vuoti o ripetuti').count).toBe(2)
  })
})

describe('registry-audit: i buchi che restano', () => {
  it('gli «object» senza colonne sono gli unici a bloccare una conversione', () => {
    const { report } = auditOf()
    const before = gap(report, '«object» senza schema di riga').count

    const { report: after } = auditOf((fields) => {
      delete fields.fields['accounting.entries']!.columns
    })

    expect(gap(after, '«object» senza schema di riga').count).toBe(before + 1)
    expect(after.conversion.readyTypes).toBeLessThan(report.conversion.readyTypes)
  })

  it('un attributo spostato fra i derivati non conta più fra quelli senza nessuno che li calcola', () => {
    const { report } = auditOf()
    expect(gap(report, 'attributi obbligatori').count).toBe(0)

    const { report: after } = auditOf((_fields, map) => {
      const fattura = map.document_types['accounting.fattura']!
      fattura.derived_fields = fattura.derived_fields!.filter((f) => f !== 'counterparty.role')
      fattura.required_fields!.push('counterparty.role')
    })
    expect(gap(after, 'attributi obbligatori').count).toBe(1)
  })
})
