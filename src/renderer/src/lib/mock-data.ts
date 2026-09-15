import type { DashboardKpi, ReviewDocument } from '@shared/types'

/**
 * Dati demo derivati da `lib/document-review/mock-data.ts` del modulo v5.2, riportati
 * sui contratti di questa app (niente `practiceCode`/`customer`: qui la sorgente è
 * Google Drive). Servono solo finché la pipeline IPC non è collegata (F0).
 */
export const dashboardKpis: DashboardKpi[] = [
  { id: 'documents', label: 'Totale documenti', value: 3, hint: 'snapshot demo' },
  { id: 'review', label: 'Da verificare', value: 3, hint: 'in attesa di controllo' },
  { id: 'low', label: 'Confidence bassa', value: 1, hint: 'sotto la soglia del 75%' },
  { id: 'types', label: 'Tipi da assegnare', value: 1, hint: 'nessun match nel registry' }
]

export const mockDocuments: ReviewDocument[] = [
  {
    id: 'doc_demo_fattura',
    driveFileId: 'drive_demo_1',
    filename: 'Fattura 2026-114.pdf',
    mime: 'application/pdf',
    documentType: 'accounting.fattura',
    documentTypeLabel: 'fattura',
    typeConfidence: 0.9,
    status: 'NEEDS_REVIEW',
    confidence: 0.91,
    confidenceBand: 'HIGH',
    receivedAt: '2026-09-10T09:42:00.000Z',
    syncedAt: '2026-09-10T09:45:00.000Z',
    source: 'Google Drive',
    textSource: 'NATIVE_TEXT',
    cachedPath: null,
    warnings: [],
    fields: [
      {
        id: 'f1',
        name: 'document_number',
        label: 'Numero documento',
        value: '114/2026',
        confidence: 0.85,
        evidenceId: 'ev1',
        required: true,
        semanticType: 'string'
      },
      {
        id: 'f2',
        name: 'issue_date',
        label: 'Data di emissione',
        value: '2026-09-08',
        confidence: 0.85,
        evidenceId: 'ev2',
        required: true,
        semanticType: 'date'
      },
      {
        id: 'f3',
        name: 'issuer_name',
        label: 'Emittente',
        value: 'Alfa S.r.l.',
        confidence: 0.7,
        evidenceId: 'ev3',
        required: false,
        semanticType: 'string'
      },
      {
        id: 'f4',
        name: 'total_amount',
        label: 'Totale',
        value: '86420.00',
        confidence: 0.85,
        evidenceId: 'ev4',
        required: false,
        semanticType: 'money'
      }
    ],
    evidence: [
      {
        id: 'ev1',
        label: 'Numero documento',
        page: 1,
        text: 'Fattura n. 114/2026',
        confidence: 0.85
      },
      { id: 'ev2', label: 'Data di emissione', page: 1, text: 'del 08/09/2026', confidence: 0.85 },
      { id: 'ev3', label: 'Emittente', page: 1, text: 'ALFA S.R.L.', confidence: 0.7 },
      { id: 'ev4', label: 'Totale', page: 2, text: '€ 86.420,00', confidence: 0.85 }
    ],
    timeline: [
      {
        id: 't1',
        at: '2026-09-10T09:42:00.000Z',
        title: 'Documento sincronizzato',
        detail: 'Scaricato da Google Drive nella cache locale.'
      },
      {
        id: 't2',
        at: '2026-09-10T09:43:00.000Z',
        title: 'Tipo riconosciuto',
        detail: 'accounting.fattura (90%) dal registry PraticaAI.'
      },
      {
        id: 't3',
        at: '2026-09-10T09:43:00.000Z',
        title: 'Campi precompilati',
        detail: '4 campi su 8 con evidenza verbatim.'
      }
    ]
  },
  {
    id: 'doc_demo_durc',
    driveFileId: 'drive_demo_2',
    filename: 'DURC_Beta.pdf',
    mime: 'application/pdf',
    documentType: 'employment.durc',
    documentTypeLabel: 'DURC',
    typeConfidence: 0.7,
    status: 'NEEDS_REVIEW',
    confidence: 0.78,
    confidenceBand: 'MEDIUM',
    receivedAt: '2026-09-09T15:18:00.000Z',
    syncedAt: '2026-09-10T09:45:00.000Z',
    source: 'Google Drive',
    textSource: 'OCR',
    cachedPath: null,
    warnings: ['Testo ricavato da OCR: la confidence dei campi è ridotta di 0,10.'],
    fields: [
      {
        id: 'b1',
        name: 'issuer_name',
        label: 'Emittente',
        value: 'INPS',
        confidence: 0.75,
        evidenceId: 'bev1',
        required: false,
        semanticType: 'string'
      },
      {
        id: 'b2',
        name: 'issue_date',
        label: 'Data di emissione',
        value: '2026-09-01',
        confidence: 0.75,
        evidenceId: 'bev2',
        required: true,
        semanticType: 'date'
      },
      {
        id: 'b3',
        name: 'document_number',
        label: 'Numero documento',
        value: '',
        confidence: 0,
        required: true,
        semanticType: 'string'
      }
    ],
    evidence: [
      {
        id: 'bev1',
        label: 'Emittente',
        page: 1,
        text: 'ISTITUTO NAZIONALE PREVIDENZA SOCIALE',
        confidence: 0.75
      },
      { id: 'bev2', label: 'Data di emissione', page: 1, text: 'del 01/09/2026', confidence: 0.75 }
    ],
    timeline: [
      {
        id: 'bt1',
        at: '2026-09-09T15:18:00.000Z',
        title: 'Documento sincronizzato',
        detail: 'Scaricato da Google Drive nella cache locale.'
      },
      {
        id: 'bt2',
        at: '2026-09-09T15:19:00.000Z',
        title: 'OCR eseguito',
        detail: 'Nessun text layer: 1 pagina passata da tesseract (ita+eng).'
      }
    ]
  },
  {
    id: 'doc_demo_ignoto',
    driveFileId: 'drive_demo_3',
    filename: 'scansione_2026_09_08.pdf',
    mime: 'application/pdf',
    documentType: null,
    documentTypeLabel: null,
    typeConfidence: null,
    status: 'NEEDS_REVIEW',
    confidence: 0.55,
    confidenceBand: 'LOW',
    receivedAt: '2026-09-08T11:06:00.000Z',
    syncedAt: '2026-09-10T09:45:00.000Z',
    source: 'Google Drive',
    textSource: 'NATIVE_TEXT',
    cachedPath: null,
    warnings: ['Tipo da assegnare a mano: nessun alias del registry supera la soglia.'],
    fields: [
      {
        id: 'g1',
        name: 'amount',
        label: 'Importo',
        value: '12840.50',
        confidence: 0.7,
        evidenceId: 'gev1',
        required: false,
        semanticType: 'money'
      },
      {
        id: 'g2',
        name: 'issue_date',
        label: 'Data di emissione',
        value: '',
        confidence: 0,
        required: true,
        semanticType: 'date'
      }
    ],
    evidence: [{ id: 'gev1', label: 'Importo', page: 1, text: '12.840,50', confidence: 0.7 }],
    timeline: [
      {
        id: 'gt1',
        at: '2026-09-08T11:06:00.000Z',
        title: 'Documento sincronizzato',
        detail: 'Scaricato da Google Drive nella cache locale.'
      },
      {
        id: 'gt2',
        at: '2026-09-08T11:07:00.000Z',
        title: 'Tipo non riconosciuto',
        detail: 'Punteggio massimo 0,42: sotto la soglia di 0,75.'
      }
    ]
  }
]
