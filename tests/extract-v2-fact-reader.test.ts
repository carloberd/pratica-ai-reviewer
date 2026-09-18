import type {
  ClassExtractionProfile,
  ExtractionScalar,
  FieldOntologyEntry
} from '@shared/extraction-v2'
import { describe, expect, it } from 'vitest'
import type { ExtractedPage } from '../src/main/extract/types'
import {
  CONFIDENCE_NEXT_LINE,
  CONFIDENCE_SAME_LINE,
  extractFactsV2,
  foldWithOrigin,
  parseDecimal,
  readDate,
  readIdentifier,
  readInteger,
  readMoney,
  readNumber,
  readsOfLabel
} from '../src/main/extract/v2/fact-reader'
import type { ExtractionRegistryV2 } from '../src/main/extract/v2/profile-loader'
import { testRegistryV2 } from './helpers/registry'

interface FieldSpec {
  type: ExtractionScalar
  labels: string[]
  format?: string
  many?: boolean
  validators?: string[]
  legacy?: string[]
}

/**
 * Registry minimale scritto nel test: ogni caso dichiara solo i campi che gli servono,
 * con le etichette esatte, così una regola del lettore non dipende dagli hint reali.
 */
function registryOf(
  fields: Record<string, FieldSpec>,
  roles: Partial<Pick<ClassExtractionProfile, 'required_fields' | 'optional_fields'>> = {}
): ExtractionRegistryV2 {
  const ids = Object.keys(fields)
  const required = roles.required_fields ?? []
  const optional = roles.optional_fields ?? []
  const profile: ClassExtractionProfile = {
    document_type_id: 'test.tipo',
    canonical_name: 'tipo di prova',
    family: 'test',
    schema_state: 'EXTRACTION_SCHEMA_DRAFT',
    evidence_basis: 'TEST',
    required_fields: required,
    core_fields: ids.filter((id) => !required.includes(id) && !optional.includes(id)),
    optional_fields: optional,
    conditional_fields: [],
    literal_evidence_required: true,
    unknown_value_policy: 'LEAVE_EMPTY',
    review_policy: 'TEST'
  }
  const entry = (id: string, spec: FieldSpec): FieldOntologyEntry => ({
    id,
    label_it: spec.labels[0] ?? id,
    type: spec.type,
    format: spec.format ?? null,
    default_cardinality: spec.many ? 'many' : 'one',
    pii: 'none',
    evidence_required: true,
    validators: spec.validators ?? [],
    description: id,
    label_aliases_it: []
  })
  return {
    profile: (type) => (type === 'test.tipo' ? profile : null),
    baseProfile: (type) => (type === 'test.tipo' ? profile : null),
    field: (id) => (fields[id] ? entry(id, fields[id]) : null),
    allFields: () => Object.entries(fields).map(([id, spec]) => entry(id, spec)),
    hints: (id) => fields[id]?.labels ?? [],
    profileSource: (type) => (type === 'test.tipo' ? 'V2_EXPLICIT' : 'MISSING'),
    legacyNames: (id) => fields[id]?.legacy ?? [],
    schemaVersion: () => 'test'
  }
}

function page(lines: string[], number = 1): ExtractedPage {
  return { page: number, text: lines.join('\n'), lines: lines.map((text) => ({ text })) }
}

function extract(registry: ExtractionRegistryV2, pages: ExtractedPage[], fromOcr = false) {
  const result = extractFactsV2({ documentType: 'test.tipo', pages, registry, fromOcr })
  const fact = (id: string) => result.facts.find((f) => f.fieldId === id)!
  return { result, fact }
}

describe('nessun valore senza evidenza', () => {
  it('senza etichetta il campo resta vuoto e MISSING', () => {
    const registry = registryOf({
      'document.issue_date': { type: 'date', labels: ['data emissione'] }
    })
    const { fact } = extract(registry, [page(['Bologna, 08/09/2026'])])
    expect(fact('document.issue_date')).toMatchObject({
      value: null,
      confidence: 0,
      evidence: [],
      reviewStatus: 'MISSING'
    })
  })

  it('un’etichetta senza un valore leggibile non inventa niente', () => {
    const registry = registryOf({
      'document.issue_date': { type: 'date', labels: ['data emissione'] },
      'money.total': { type: 'money', labels: ['totale'] }
    })
    const { fact } = extract(registry, [
      page(['Data emissione: da definire', 'Totale: vedi allegato'])
    ])
    expect(fact('document.issue_date').value).toBeNull()
    expect(fact('money.total').value).toBeNull()
  })

  it('ogni valore porta la riga verbatim da cui viene', () => {
    const registry = registryOf({ 'issuer.name': { type: 'string', labels: ['emittente'] } })
    const lines: ExtractedPage = {
      page: 2,
      text: 'Emittente: Alfa S.r.l.',
      lines: [{ text: 'Emittente: Alfa S.r.l.', bbox: { x: 10, y: 20, w: 100, h: 12 } }]
    }
    const { fact } = extract(registry, [lines])
    expect(fact('issuer.name')).toMatchObject({
      value: 'Alfa S.r.l.',
      confidence: CONFIDENCE_SAME_LINE,
      reviewStatus: 'AUTO_ACCEPTED',
      evidence: [{ page: 2, text: 'Emittente: Alfa S.r.l.', bbox: { x: 10, y: 20, w: 100, h: 12 } }]
    })
  })

  it('una richiesta di un tipo senza profilo è un errore esplicito', () => {
    expect(() =>
      extractFactsV2({ documentType: 'altro', pages: [], registry: registryOf({}) })
    ).toThrow('Nessun profilo di estrazione per altro.')
  })
})

describe('posizione del valore', () => {
  it('etichetta e valore sulla stessa riga, anche senza i due punti per i tipi numerici', () => {
    const registry = registryOf({ 'money.total': { type: 'money', labels: ['totale documento'] } })
    const { fact } = extract(registry, [page(['Totale documento EUR 86.420,00'])])
    expect(fact('money.total').value).toBe('86420.00')
  })

  it('etichetta a fine riga e valore sulla riga successiva', () => {
    const registry = registryOf({
      'recipient.name': { type: 'string', labels: ['destinatario'] },
      'document.issue_date': { type: 'date', labels: ['data di emissione'] }
    })
    const doc: ExtractedPage = {
      page: 1,
      text: '',
      lines: [
        { text: 'Destinatario:', bbox: { x: 10, y: 10, w: 60, h: 10 } },
        { text: 'Beta Costruzioni S.p.A.', bbox: { x: 10, y: 22, w: 120, h: 10 } },
        { text: 'Data di emissione' },
        { text: '01/09/2026' }
      ]
    }
    const { fact } = extract(registry, [doc])
    expect(fact('recipient.name')).toMatchObject({
      value: 'Beta Costruzioni S.p.A.',
      confidence: CONFIDENCE_NEXT_LINE,
      reviewStatus: 'NEEDS_REVIEW',
      evidence: [
        {
          text: 'Destinatario:\nBeta Costruzioni S.p.A.',
          bbox: { x: 10, y: 10, w: 120, h: 22 }
        }
      ]
    })
    expect(fact('document.issue_date').value).toBe('2026-09-01')
  })

  it('la riga successiva non vale se è a sua volta un’etichetta con valore', () => {
    const registry = registryOf({ 'recipient.name': { type: 'string', labels: ['destinatario'] } })
    const { fact } = extract(registry, [page(['Destinatario:', 'Oggetto: fornitura'])])
    expect(fact('recipient.name').value).toBeNull()
  })

  it('il testo libero vuole l’etichetta in testa al segmento, non a metà frase', () => {
    const registry = registryOf({ 'recipient.name': { type: 'string', labels: ['cliente'] } })
    expect(
      extract(registry, [page(['Codice cliente: 12345'])]).fact('recipient.name').value
    ).toBeNull()
    expect(
      extract(registry, [page(['Fattura n. 114 - Cliente: Alfa S.r.l.'])]).fact('recipient.name')
        .value
    ).toBe('Alfa S.r.l.')
  })

  it('un valore tipizzato troppo lontano dall’etichetta non le appartiene', () => {
    const registry = registryOf({ 'document.issue_date': { type: 'date', labels: ['del'] } })
    const far = `Il contratto del cliente ${'x'.repeat(50)} firmato il 01/02/2026`
    expect(extract(registry, [page([far])]).fact('document.issue_date').value).toBeNull()
  })

  it('l’etichetta si cerca a confini di parola, senza accenti né maiuscole', () => {
    const registry = registryOf({ 'money.amount': { type: 'money', labels: ['importo'] } })
    expect(extract(registry, [page(['Importone: 100,00'])]).fact('money.amount').value).toBeNull()
    expect(extract(registry, [page(['IMPORTO € 100,00'])]).fact('money.amount').value).toBe(
      '100.00'
    )
  })

  it('cerca su tutte le pagine', () => {
    const registry = registryOf({ 'money.total': { type: 'money', labels: ['totale'] } })
    const { fact } = extract(registry, [page(['Intestazione']), page(['Totale: 12,50 €'], 2)])
    expect(fact('money.total')).toMatchObject({ value: '12.50', evidence: [{ page: 2 }] })
  })
})

describe('normalizzazione dei valori', () => {
  it('date numeriche e testuali in yyyy-mm-dd', () => {
    expect(readDate(': 08/09/2026', 40)).toBe('2026-09-08')
    expect(readDate(' 1.9.26', 40)).toBe('2026-09-01')
    expect(readDate(' 12 settembre 2026', 40)).toBe('2026-09-12')
    expect(readDate(' 31 febbraio 2026', 40)).toBeNull()
    expect(readDate(' 31/02/2026', 40)).toBeNull()
  })

  it('importi a due decimali col punto', () => {
    expect(readMoney(' € 1.234,56', 40)).toBe('1234.56')
    expect(readMoney(' EUR 86.420', 40)).toBe('86420.00')
    expect(readMoney(' 2026', 40)).toBeNull()
  })

  it('una data prima dell’importo non prende il suo posto', () => {
    expect(readMoney(' al 31.12.2025 di 1.234,56', 40)).toBe('1234.56')
    expect(readMoney(' del 08/09/2026', 40)).toBeNull()
  })

  it('interi senza separatori delle migliaia, e niente decimali', () => {
    expect(readInteger(' 1.250 colli', 40)).toBe('1250')
    expect(readInteger(': 12', 40)).toBe('12')
    expect(readInteger(': 12,5', 40)).toBeNull()
  })

  it('decimali all’italiana', () => {
    expect(parseDecimal('22,5')).toBe('22.5')
    expect(parseDecimal('1.250')).toBe('1250')
    expect(parseDecimal('1.234,56')).toBe('1234.56')
    expect(parseDecimal('1,234.56')).toBe('1234.56')
    expect(parseDecimal('3.5')).toBe('3.5')
    expect(readNumber(' 22,5%', 40)).toBe('22.5')
  })

  it('identificativi come token, con prefissi n./nr. tolti', () => {
    expect(readIdentifier(' n. 2026/554321', null)).toBe('2026/554321')
    expect(readIdentifier(': CC-2026-018.', null)).toBe('CC-2026-018')
    expect(readIdentifier(' generale', null)).toBeNull()
    expect(readIdentifier(' n. 7', null)).toBe('7')
    expect(readIdentifier(': 7', null)).toBe('7')
    expect(readIdentifier(' 0 1 Get the current block', null)).toBeNull()
    expect(readIdentifier(' 08/09/2026', null)).toBeNull()
    expect(readIdentifier(': 01234567890', 'tax_id')).toBe('01234567890')
    expect(readIdentifier(': rssmra80a01h501u', 'italian_tax_code')).toBe('RSSMRA80A01H501U')
    expect(readIdentifier(': IT60 X054 2811 1010 0000 0123 456', 'iban')).toBe(
      'IT60X0542811101000000123456'
    )
  })

  it('il testo ripiegato ricorda la posizione originale di ogni carattere', () => {
    const folded = foldWithOrigin('Città:  Forlì')
    expect(folded.folded).toBe('citta forli')
    expect(folded.origin[6]).toBe(8)
  })

  it('un validatore fallito abbassa la confidence e manda il campo in revisione', () => {
    const registry = registryOf({
      'bank.iban': {
        type: 'identifier',
        format: 'iban',
        labels: ['iban'],
        validators: ['iban_checksum']
      }
    })
    const { fact } = extract(registry, [page(['IBAN: IT61X0542811101000000123456'])])
    expect(fact('bank.iban')).toMatchObject({
      value: 'IT61X0542811101000000123456',
      validationErrors: ['INVALID_IBAN'],
      reviewStatus: 'NEEDS_REVIEW',
      confidence: 0.67
    })
  })

  it('da OCR la confidence scende di 0,10 e il valore va rivisto', () => {
    const registry = registryOf({ 'issuer.name': { type: 'string', labels: ['emittente'] } })
    const { fact } = extract(registry, [page(['Emittente: INPS'])], true)
    expect(fact('issuer.name')).toMatchObject({ confidence: 0.75, reviewStatus: 'NEEDS_REVIEW' })
  })
})

describe('candidati concorrenti', () => {
  it('l’etichetta più lunga vince: l’imponibile non finisce nel totale', () => {
    const registry = registryOf({
      'money.total': { type: 'money', labels: ['totale', 'totale documento'] }
    })
    const { fact, result } = extract(registry, [
      page(['Totale imponibile EUR 70.836,07', 'Totale documento EUR 86.420,00'])
    ])
    expect(fact('money.total')).toMatchObject({ value: '86420.00', reviewStatus: 'AUTO_ACCEPTED' })
    expect(result.conflicts).toEqual([])
  })

  it('la stessa riga con lo stesso valore va al campo con l’etichetta più specifica', () => {
    const registry = registryOf({
      'document.protocol_number': { type: 'string', labels: ['protocollo'] },
      'document.number': { type: 'string', labels: ['n'] }
    })
    const { fact } = extract(registry, [page(['Protocollo n. 2026/554321'])])
    expect(fact('document.protocol_number').value).toBe('2026/554321')
    expect(fact('document.number')).toMatchObject({ value: null, reviewStatus: 'MISSING' })
  })

  it('a parità di etichetta la riga condivisa manda entrambi i campi in CONFLICT', () => {
    const registry = registryOf({
      'issuer.name': { type: 'string', labels: ['ragione sociale'] },
      'company.name': { type: 'string', labels: ['ragione sociale'] }
    })
    const { fact, result } = extract(registry, [page(['Ragione sociale: Alfa S.r.l.'])])
    expect(fact('issuer.name')).toMatchObject({ value: 'Alfa S.r.l.', reviewStatus: 'CONFLICT' })
    expect(fact('company.name')).toMatchObject({ value: 'Alfa S.r.l.', reviewStatus: 'CONFLICT' })
    expect(result.conflicts).toEqual(['SHARED_EVIDENCE:issuer.name|company.name'])
  })

  it('due valori diversi con la stessa etichetta sono un conflitto, non una scelta', () => {
    const registry = registryOf({ 'issuer.name': { type: 'string', labels: ['emittente'] } })
    const { fact, result } = extract(registry, [
      page(['Emittente: Alfa S.r.l.', 'Emittente: Gamma S.p.A.'])
    ])
    expect(fact('issuer.name')).toMatchObject({ value: 'Alfa S.r.l.', reviewStatus: 'CONFLICT' })
    expect(result.conflicts).toEqual(['MULTIPLE_CANDIDATES:issuer.name'])
  })
})

describe('etichette imparate dalle revisioni', () => {
  const learned = (
    fieldId: string,
    label: string,
    overrides: Partial<{
      ruleId: string
      relation: 'same-line' | 'next-line'
      scope: 'TEMPLATE' | 'CLASS'
    }> = {}
  ) => ({
    ruleId: overrides.ruleId ?? `rule-${label}`,
    fieldId,
    label,
    relation: overrides.relation ?? 'same-line',
    scope: overrides.scope ?? 'TEMPLATE'
  })

  it('un’etichetta imparata trova il valore che il registry non trova, e dice da quale regola', () => {
    const registry = registryOf({
      'document.issue_date': { type: 'date', labels: ['data emissione'] }
    })
    const pages = [page(['Promemoria interno', 'Data: 12/09/2026'])]
    const result = extractFactsV2({
      documentType: 'test.tipo',
      pages,
      registry,
      learnedLabels: [learned('document.issue_date', 'data', { ruleId: 'r-data' })]
    })
    expect(result.facts[0]).toMatchObject({
      value: '2026-09-12',
      reviewStatus: 'AUTO_ACCEPTED',
      evidence: [{ page: 1, text: 'Data: 12/09/2026', ruleId: 'r-data' }]
    })
    // Senza, il campo resta vuoto: il miglioramento viene dalla regola.
    expect(extract(registry, pages).fact('document.issue_date').value).toBeNull()
  })

  it('passa davanti all’etichetta più lunga del registry', () => {
    const registry = registryOf({
      'money.total': { type: 'money', labels: ['totale documento'] }
    })
    const result = extractFactsV2({
      documentType: 'test.tipo',
      pages: [page(['Totale documento EUR 86.420,00', 'Da pagare EUR 80.000,00'])],
      registry,
      learnedLabels: [learned('money.total', 'da pagare', { scope: 'CLASS' })]
    })
    expect(result.facts[0]).toMatchObject({ value: '80000.00', reviewStatus: 'AUTO_ACCEPTED' })
  })

  it('una regola di template passa davanti a una di tipo', () => {
    const registry = registryOf({ 'money.total': { type: 'money', labels: [] } })
    const result = extractFactsV2({
      documentType: 'test.tipo',
      pages: [page(['Totale EUR 1.000,00', 'Saldo EUR 900,00'])],
      registry,
      learnedLabels: [
        learned('money.total', 'totale', { scope: 'CLASS', ruleId: 'class' }),
        learned('money.total', 'saldo', { scope: 'TEMPLATE', ruleId: 'template' })
      ]
    })
    expect(result.facts[0]).toMatchObject({
      value: '900.00',
      evidence: [{ ruleId: 'template' }]
    })
  })

  it('la stessa etichetta del registry, imparata, vale col livello della regola', () => {
    const registry = registryOf({ 'money.total': { type: 'money', labels: ['totale'] } })
    const result = extractFactsV2({
      documentType: 'test.tipo',
      pages: [page(['Totale EUR 1.000,00'])],
      registry,
      learnedLabels: [learned('money.total', 'Totale', { ruleId: 'r-totale' })]
    })
    expect(result.facts[0]?.evidence[0]?.ruleId).toBe('r-totale')
  })

  it('una regola legge solo nella sua relazione', () => {
    const registry = registryOf({ 'document.issue_date': { type: 'date', labels: [] } })
    const lines = ['Data', '12/09/2026']
    const read = (relation: 'same-line' | 'next-line') =>
      extractFactsV2({
        documentType: 'test.tipo',
        pages: [page(lines)],
        registry,
        learnedLabels: [learned('document.issue_date', 'data', { relation })]
      }).facts[0]?.value
    expect(read('next-line')).toBe('2026-09-12')
    expect(read('same-line')).toBeNull()
  })

  it('i validatori restano l’ultima parola anche per un’etichetta imparata', () => {
    const registry = registryOf({
      'bank.iban': { type: 'identifier', format: 'iban', labels: [], validators: ['iban_checksum'] }
    })
    const result = extractFactsV2({
      documentType: 'test.tipo',
      pages: [page(['Coordinate: IT61X0542811101000000123456'])],
      registry,
      learnedLabels: [learned('bank.iban', 'coordinate')]
    })
    expect(result.facts[0]).toMatchObject({
      value: 'IT61X0542811101000000123456',
      validationErrors: ['INVALID_IBAN'],
      reviewStatus: 'NEEDS_REVIEW'
    })
  })

  it('un’etichetta per un campo fuori dal profilo non cambia niente', () => {
    const registry = registryOf({ 'money.total': { type: 'money', labels: ['totale'] } })
    const result = extractFactsV2({
      documentType: 'test.tipo',
      pages: [page(['Data: 12/09/2026', 'Totale EUR 10,00'])],
      registry,
      learnedLabels: [learned('document.issue_date', 'data')]
    })
    expect(result.facts.map((fact) => fact.fieldId)).toEqual(['money.total'])
  })

  it('le letture di un’etichetta: dove compare e cosa legge', () => {
    const spec = registryOf({ 'money.total': { type: 'money', labels: [] } }).field('money.total')!
    const lines = [{ text: 'Totale EUR 10,00' }, { text: 'Totale' }, { text: '20,00' }]
    expect(readsOfLabel('money.total', spec, lines, 'Totale')).toEqual([
      { line: 0, valueLine: 0, sameLine: true, labelEnd: 6, value: '10.00' },
      { line: 1, valueLine: 2, sameLine: false, labelEnd: 6, value: '20.00' }
    ])
    expect(readsOfLabel('money.total', spec, lines, 'totale', 'next-line')).toHaveLength(1)
  })
})

describe('campi ripetuti', () => {
  it('un elemento per riga, in ordine di documento, ciascuno con la sua evidenza', () => {
    const registry = registryOf({
      'insurance.coverages': { type: 'object', labels: ['garanzia'], many: true }
    })
    const { fact } = extract(registry, [
      page(['Garanzia: Incendio', 'Premio: 100,00', 'Garanzia: Furto']),
      page(['Garanzia:', 'Responsabilità civile'], 2)
    ])
    expect(fact('insurance.coverages')).toMatchObject({
      cardinality: 'many',
      value: ['Incendio', 'Furto', 'Responsabilità civile'],
      evidence: [
        { page: 1, text: 'Garanzia: Incendio' },
        { page: 1, text: 'Garanzia: Furto' },
        { page: 2, text: 'Garanzia:\nResponsabilità civile' }
      ],
      reviewStatus: 'NEEDS_REVIEW'
    })
    expect(fact('insurance.coverages').confidence).toBeCloseTo(0.83, 2)
  })

  it('senza righe il campo many resta vuoto', () => {
    const registry = registryOf(
      { line_items: { type: 'object', labels: ['righe documento'], many: true } },
      { required_fields: ['line_items'] }
    )
    const { fact, result } = extract(registry, [page(['nessuna tabella'])])
    expect(fact('line_items')).toMatchObject({
      value: null,
      reviewStatus: 'MISSING',
      role: 'required'
    })
    expect(result.missingRequired).toEqual(['line_items'])
  })
})

describe('esito complessivo', () => {
  it('ruoli, obbligatori mancanti, copertura e confidence media', () => {
    const registry = registryOf(
      {
        'document.number': { type: 'string', labels: ['numero documento'] },
        'document.issue_date': { type: 'date', labels: ['data'] },
        'recipient.name': { type: 'string', labels: ['destinatario'] }
      },
      {
        required_fields: ['document.number', 'document.issue_date'],
        optional_fields: ['recipient.name']
      }
    )
    const { result, fact } = extract(registry, [page(['Data: 12/09/2026'])])
    expect(fact('document.number').role).toBe('required')
    expect(fact('recipient.name').role).toBe('optional')
    expect(result).toMatchObject({
      documentType: 'test.tipo',
      schemaState: 'EXTRACTION_SCHEMA_DRAFT',
      missingRequired: ['document.number'],
      coverage: 0.33,
      confidence: CONFIDENCE_SAME_LINE
    })
  })

  it('un campo del profilo che l’ontologia non descrive resta nel run, vuoto', () => {
    const registry = registryOf(
      { 'document.issue_date': { type: 'date', labels: ['data'] } },
      { required_fields: ['document.issue_date', 'ghost.field'] }
    )
    const { result, fact } = extract(registry, [page(['Data: 12/09/2026'])])

    expect(fact('ghost.field')).toMatchObject({
      role: 'required',
      value: null,
      confidence: 0,
      evidence: [],
      reviewStatus: 'MISSING',
      // Non cercato, non «assente dal documento»: la differenza sta qui.
      validationErrors: ['UNKNOWN_FIELD']
    })
    expect(result.missingRequired).toEqual(['ghost.field'])
    expect(result.conflicts).toEqual(['UNKNOWN_FIELD:ghost.field'])
    // Un obbligatorio mai cercato non può lasciare la copertura piena.
    expect(result.coverage).toBe(0.5)
  })

  it('usa le keyword v1 dei campi legacy mappati: «Data di emissione» non è negli hint v2', () => {
    const registry = testRegistryV2()
    expect(registry.hints('document.issue_date').map((h) => h.toLowerCase())).not.toContain(
      'data di emissione'
    )
    const result = extractFactsV2({
      documentType: 'payroll_contributions.durc',
      pages: [page(['DURC', 'Protocollo n. 2026/554321', 'Data di emissione: 01/09/2026'])],
      registry
    })
    const values = Object.fromEntries(result.facts.map((f) => [f.fieldId, f.value]))
    expect(values['document.issue_date']).toBe('2026-09-01')
    expect(values['document.protocol_number']).toBe('2026/554321')
    // Il profilo del DURC non chiede un «numero documento» distinto dal protocollo.
    expect(values['document.number']).toBeNull()
  })
})
