import { describe, expect, it } from 'vitest'
import {
  buildXlsxRows,
  classifierAudit,
  type XlsxFieldRow,
  type XlsxSource
} from '../src/shared/dataset-xlsx'
import type { EvidenceItem } from '../src/shared/types'
import { item, listField, reviewDocument, scalarField } from './helpers/review-document'

/**
 * Le due tabelle dell'export XLSX a partire da `ReviewDocument` già letti: nessun
 * database, nessun file. Quello che si prova qui è la forma delle righe — un campo
 * corretto, le righe di un campo ripetuto, un documento classificato col v1 e uno senza
 * copia in cache.
 */

const EVIDENCE: EvidenceItem[] = [
  {
    id: 'e-number',
    label: 'Numero documento',
    page: 1,
    text: 'FATTURA n. 114/2026 del 08/09/2026',
    confidence: 0.85,
    bbox: { x: 56, y: 91, w: 181.6, h: 11 }
  },
  {
    id: 'e-line-0',
    label: 'Righe documento',
    page: 2,
    text: 'Demolizione tramezzi - EUR 3.200,00',
    confidence: 0.8
  }
]

/** Audit del classificatore v2 come lo scrive la pipeline in `metrics_json`. */
const METRICS_V2 = JSON.stringify({
  textSource: 'NATIVE_TEXT',
  classifier: {
    engine: 'v2',
    manualType: false,
    decision: 'ASSIGN',
    reason: 'OK',
    top: { documentType: 'accounting.fattura', score: 0.83 },
    runnerUp: { documentType: 'accounting.nota_credito', confidence: 0.41 },
    margin: 0.42
  }
})

/** Il v1 non calcola né secondo candidato né margine: nel suo audit non ci sono proprio. */
const METRICS_V1 = JSON.stringify({
  textSource: 'NATIVE_TEXT',
  classifier: {
    engine: 'v1',
    manualType: false,
    documentType: 'accounting.fattura',
    confidence: 0.7,
    phrase: 'fattura',
    source: 'page'
  }
})

function source(overrides: Partial<XlsxSource> = {}): XlsxSource {
  return {
    document: reviewDocument({ status: 'REVIEWED' }),
    metricsJson: METRICS_V2,
    templateFingerprint: 'a1b2c3d4e5f60718',
    ...overrides
  }
}

const byName = (rows: XlsxFieldRow[], name: string) => rows.filter((row) => row.field_name === name)

describe('righe dell’export XLSX', () => {
  it('il foglio documents tiene predizione e verità del revisore, col secondo candidato', () => {
    const { documents } = buildXlsxRows([source()])

    expect(documents).toEqual([
      {
        document_id: 'doc-1',
        drive_file_id: 'drive-1',
        document_type_predicted: 'accounting.fattura',
        document_type_final: 'accounting.fattura',
        classifier_confidence: 0.83,
        runner_up: 'accounting.nota_credito',
        margin: 0.42,
        template_fingerprint: 'a1b2c3d4e5f60718',
        review_status: 'REVIEWED'
      }
    ])
  })

  it('tipo assegnato a mano: nessuna predizione, ma la verità c’è lo stesso', () => {
    const { documents } = buildXlsxRows([
      source({
        document: reviewDocument({
          status: 'REVIEWED',
          documentType: 'payments_treasury.richiesta_pagamento',
          typeConfidence: null
        })
      })
    ])

    expect(documents[0]).toMatchObject({
      document_type_predicted: null,
      document_type_final: 'payments_treasury.richiesta_pagamento',
      classifier_confidence: null
    })
  })

  it('col motore v1 runner-up e margine restano vuoti: non si inventano', () => {
    const { documents } = buildXlsxRows([source({ metricsJson: METRICS_V1 })])
    expect(documents[0]).toMatchObject({ runner_up: null, margin: null })
  })

  it('senza run, o con un audit illeggibile, le due colonne restano vuote', () => {
    expect(classifierAudit(null)).toEqual({ runnerUp: null, margin: null })
    expect(classifierAudit('{ questo non è json')).toEqual({ runnerUp: null, margin: null })
    expect(classifierAudit('{"classifier":{"engine":"v2"}}')).toEqual({
      runnerUp: null,
      margin: null
    })
  })

  it('documento non più in cache: impronta vuota, il resto della riga c’è tutto', () => {
    const { documents } = buildXlsxRows([source({ templateFingerprint: null })])
    expect(documents[0]).toMatchObject({
      document_id: 'doc-1',
      template_fingerprint: null,
      review_status: 'REVIEWED'
    })
  })

  it('campo corretto: la proposta del motore accanto al valore confermato, con l’evidenza', () => {
    const { fields } = buildXlsxRows([
      source({
        document: reviewDocument({
          status: 'REVIEWED',
          evidence: EVIDENCE,
          fields: [scalarField({ correctedValue: '114/2026/B', evidenceId: 'e-number' })]
        })
      })
    ])

    expect(fields).toEqual([
      {
        document_id: 'doc-1',
        field_name: 'document.number',
        label: 'Numero documento',
        role: 'required',
        cardinality: 'one',
        item_index: null,
        value_predicted: '114/2026',
        value_final: '114/2026/B',
        origin: 'REVIEWER',
        confidence: 0.85,
        evidence_page: 1,
        evidence_text: 'FATTURA n. 114/2026 del 08/09/2026',
        evidence_bbox: '{"x":56,"y":91,"w":181.6,"h":11}'
      }
    ])
  })

  it('campo confermato così com’era: origine ENGINE', () => {
    const { fields } = buildXlsxRows([
      source({ document: reviewDocument({ status: 'REVIEWED', fields: [scalarField()] }) })
    ])
    expect(fields[0]).toMatchObject({
      value_predicted: '114/2026',
      value_final: '114/2026',
      origin: 'ENGINE',
      evidence_page: null,
      evidence_text: null,
      evidence_bbox: null
    })
  })

  it('campo svuotato dal revisore: resta la proposta, il valore finale è vuoto', () => {
    const { fields } = buildXlsxRows([
      source({
        document: reviewDocument({
          status: 'REVIEWED',
          fields: [scalarField({ correctedValue: '' })]
        })
      })
    ])
    expect(fields[0]).toMatchObject({
      value_predicted: '114/2026',
      value_final: null,
      origin: null
    })
  })

  it('campi ripetuti: una riga per item, ordinate da item_index', () => {
    const { fields } = buildXlsxRows([
      source({
        document: reviewDocument({
          status: 'REVIEWED',
          evidence: EVIDENCE,
          fields: [
            listField([
              item({ id: 'i2', index: 2, value: 'Tinteggiatura pareti', removed: true }),
              item({
                id: 'i0',
                index: 0,
                value: 'Demolizione tramezzi',
                evidenceId: 'e-line-0'
              }),
              item({
                id: 'i1',
                index: 1,
                value: 'Smaltimento macerie',
                correctedValue: 'Smaltimento macerie in discarica'
              }),
              item({
                id: 'i3',
                index: 3,
                value: '',
                correctedValue: 'Posa in opera',
                origin: 'MANUAL'
              })
            ])
          ]
        })
      })
    ])

    expect(
      fields.map((row) => [row.item_index, row.value_predicted, row.value_final, row.origin])
    ).toEqual([
      [0, 'Demolizione tramezzi', 'Demolizione tramezzi', 'ENGINE'],
      [1, 'Smaltimento macerie', 'Smaltimento macerie in discarica', 'REVIEWER'],
      // La riga tolta resta, col valore finale vuoto: quello che il motore aveva
      // proposto è una misura, non si perde.
      [2, 'Tinteggiatura pareti', null, null],
      [3, null, 'Posa in opera', 'REVIEWER']
    ])
    expect(fields.every((row) => row.cardinality === 'many')).toBe(true)
    expect(fields[0]).toMatchObject({
      evidence_page: 2,
      evidence_text: 'Demolizione tramezzi - EUR 3.200,00',
      evidence_bbox: null
    })
  })

  it('campo ripetuto senza righe: una riga vuota, per non farlo sparire dal foglio', () => {
    const { fields } = buildXlsxRows([
      source({
        document: reviewDocument({ status: 'REVIEWED', fields: [listField([])] })
      })
    ])
    expect(fields).toEqual([
      {
        document_id: 'doc-1',
        field_name: 'line_items',
        label: 'Righe documento',
        role: 'core',
        cardinality: 'many',
        item_index: null,
        value_predicted: null,
        value_final: null,
        origin: null,
        confidence: 0.85,
        evidence_page: null,
        evidence_text: null,
        evidence_bbox: null
      }
    ])
  })

  it('degli scartati resta la riga documento, senza campi: nessuno ne ha confermato i valori', () => {
    const { documents, fields } = buildXlsxRows([
      source({
        document: reviewDocument({
          status: 'DISCARDED',
          fields: [scalarField({ correctedValue: '114/2026/B' })]
        })
      })
    ])

    expect(documents[0]).toMatchObject({ review_status: 'DISCARDED' })
    expect(fields).toEqual([])
  })

  it('i documenti ancora in coda restano fuori da tutti e due i fogli', () => {
    const { documents, fields } = buildXlsxRows([
      source({ document: reviewDocument({ fields: [scalarField()] }) })
    ])
    expect(documents).toEqual([])
    expect(fields).toEqual([])
  })

  it('l’ordine è quello dei nomi file: due export dello stesso database coincidono', () => {
    const doc = (id: string, filename: string) =>
      source({
        document: reviewDocument({
          id,
          driveFileId: `drive-${id}`,
          filename,
          status: 'REVIEWED',
          fields: [scalarField({ id: `${id}-f` })]
        })
      })

    const { documents, fields } = buildXlsxRows([
      doc('c', 'Zeta.pdf'),
      doc('a', 'Alfa.pdf'),
      doc('b', 'Beta.pdf')
    ])

    expect(documents.map((row) => row.document_id)).toEqual(['a', 'b', 'c'])
    // Il foglio dei campi segue lo stesso ordine: le due tabelle si leggono in parallelo.
    expect(fields.map((row) => row.document_id)).toEqual(['a', 'b', 'c'])
    expect(byName(fields, 'document.number')).toHaveLength(3)
  })
})
