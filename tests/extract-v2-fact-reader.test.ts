import type {
  ClassExtractionProfile,
  ExtractionScalar,
  FieldOntologyEntry
} from '@shared/extraction-v2'
import { describe, expect, it } from 'vitest'
import type { ExtractedPage } from '../src/main/extract/types'
import {
  CONFIDENCE_COMPUTED,
  CONFIDENCE_NEXT_LINE,
  CONFIDENCE_SAME_LINE,
  extractFactsV2,
  fiscalTwinOf,
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

function extract(registry: ExtractionRegistryV2, pages: ExtractedPage[], ocrPages: number[] = []) {
  const result = extractFactsV2({ documentType: 'test.tipo', pages, registry, ocrPages })
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

  it('una riga che comincia con la barra è la coda dell’etichetta, non il valore', () => {
    // «Ragione sociale/Nome e cognome» andata a capo sulla barra.
    const registry = registryOf({ 'issuer.name': { type: 'string', labels: ['ragione sociale'] } })
    const read = (lines: string[]) => extract(registry, [page(lines)]).fact('issuer.name').value
    expect(read(['Ragione sociale', '/Nome e cognome'])).toBeNull()
    expect(read(['Ragione sociale', '\\ Nome e cognome'])).toBeNull()
    expect(read(['Ragione sociale: /Nome e cognome'])).toBeNull()
    // Una barra in mezzo al valore resta sua.
    expect(read(['Ragione sociale', 'Alfa S.r.l. / Beta S.p.A.'])).toBe('Alfa S.r.l. / Beta S.p.A.')
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

  it('un’etichetta fusa in coda a un identificativo fiscale vale, se chiude la riga', () => {
    // Il generatore PDF fonde la partita IVA con l'intestazione della colonna accanto.
    const registry = registryOf({ 'recipient.name': { type: 'string', labels: ['destinatario'] } })
    const read = (lines: string[]) => extract(registry, [page(lines)]).fact('recipient.name')
    expect(read(['P.IVA 01234567890 DESTINATARIO', 'BETA COSTRUZIONI SRL'])).toMatchObject({
      value: 'BETA COSTRUZIONI SRL',
      confidence: CONFIDENCE_NEXT_LINE,
      evidence: [{ text: 'P.IVA 01234567890 DESTINATARIO\nBETA COSTRUZIONI SRL' }]
    })
    expect(read(['P.IVA IT01234567890 DESTINATARIO', 'BETA COSTRUZIONI SRL']).value).toBe(
      'BETA COSTRUZIONI SRL'
    )
    expect(read(['C.F. RSSMRA80A01H501U DESTINATARIO', 'BETA COSTRUZIONI SRL']).value).toBe(
      'BETA COSTRUZIONI SRL'
    )
  })

  it('con il registry vero: «Destinatario» è fra le etichette di `recipient.name`', () => {
    const result = extractFactsV2({
      documentType: 'accounting.fattura',
      pages: [page(['P.IVA 09876543210 DESTINATARIO', 'BETA COSTRUZIONI SRL'])],
      registry: testRegistryV2()
    })
    expect(result.facts.find((fact) => fact.fieldId === 'recipient.name')).toMatchObject({
      value: 'BETA COSTRUZIONI SRL',
      reviewStatus: 'NEEDS_REVIEW'
    })
  })

  it('a metà riga, senza un identificativo intero davanti, resta a metà frase', () => {
    const registry = registryOf({ 'recipient.name': { type: 'string', labels: ['destinatario'] } })
    const read = (lines: string[]) => extract(registry, [page(lines)]).fact('recipient.name').value
    // Davanti c'è una frase, non un identificativo.
    expect(read(['Spedizione a cura del DESTINATARIO', 'BETA COSTRUZIONI SRL'])).toBeNull()
    // Dieci cifre non sono una partita IVA, e dodici sono un altro numero.
    expect(read(['P.IVA 0123456789 DESTINATARIO', 'BETA COSTRUZIONI SRL'])).toBeNull()
    expect(read(['Conto 012345678901 DESTINATARIO', 'BETA COSTRUZIONI SRL'])).toBeNull()
    // L'eccezione vale solo se l'etichetta chiude la riga: con qualcosa dopo, torna la regola
    // di sempre, anche quando quel qualcosa sarebbe il valore.
    expect(read(['P.IVA 01234567890 DESTINATARIO: BETA COSTRUZIONI SRL'])).toBeNull()
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

  it('il meno attaccato all’importo resta, un trattino che separa no', () => {
    expect(readMoney(': -1.234,56', 40)).toBe('-1234.56')
    expect(readMoney(' € -100,00', 40)).toBe('-100.00')
    expect(readMoney(' - 100,00', 40)).toBe('100.00')
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
    // Il prefisso comunitario attaccato alle cifre: senza, la partita IVA non si leggeva.
    expect(readIdentifier(': IT12345678903', 'tax_id')).toBe('12345678903')
    expect(readIdentifier(' IT 12345678903', 'tax_id')).toBe('12345678903')
    // Omocodia: lettere al posto delle cifre, e il codice resta un codice fiscale.
    expect(readIdentifier(': RSSMRA80A01H5LMX', 'italian_tax_code')).toBe('RSSMRA80A01H5LMX')
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

  it('una partita IVA con la cifra di controllo sbagliata va rivista, una giusta no', () => {
    const registry = registryOf({
      'issuer.tax_id': {
        type: 'identifier',
        format: 'tax_id',
        labels: ['partita iva'],
        validators: ['tax_id_format']
      }
    })
    const read = (line: string) => extract(registry, [page([line])]).fact('issuer.tax_id')
    expect(read('Partita IVA: IT12345678903')).toMatchObject({
      value: '12345678903',
      validationErrors: [],
      reviewStatus: 'AUTO_ACCEPTED'
    })
    // Come la legge un OCR che scambia due cifre.
    expect(read('Partita IVA: 12345678930')).toMatchObject({
      value: '12345678930',
      validationErrors: ['INVALID_TAX_ID_CHECKSUM'],
      reviewStatus: 'NEEDS_REVIEW',
      confidence: 0.67
    })
  })

  it('da OCR la confidence scende di 0,10 e il valore va rivisto', () => {
    const registry = registryOf({ 'issuer.name': { type: 'string', labels: ['emittente'] } })
    const { fact } = extract(registry, [page(['Emittente: INPS'])], [1])
    expect(fact('issuer.name')).toMatchObject({ confidence: 0.75, reviewStatus: 'NEEDS_REVIEW' })
  })

  it('la penalità è della pagina da OCR, non delle altre', () => {
    const registry = registryOf({
      'issuer.name': { type: 'string', labels: ['emittente'] },
      'money.total': { type: 'money', labels: ['totale documento'] }
    })
    const { fact } = extract(
      registry,
      [page(['Emittente: Alfa S.r.l.']), page(['Totale documento EUR 86.420,00'], 2)],
      [2]
    )
    // Un allegato scansionato in fondo non declassa i campi letti dal text layer.
    expect(fact('issuer.name')).toMatchObject({
      confidence: CONFIDENCE_SAME_LINE,
      reviewStatus: 'AUTO_ACCEPTED'
    })
    expect(fact('money.total')).toMatchObject({ confidence: 0.75, reviewStatus: 'NEEDS_REVIEW' })
  })
})

describe('etichette dentro una citazione', () => {
  // Le righe sono verbatim dall'export del 18/09/2026: due terzi degli errori di valore
  // del motore stavano su `document.number` e `document.issue_date`, e avevano questa forma.
  const numero = () => registryOf({ 'document.number': { type: 'string', labels: ['n'] } })
  const data = () => registryOf({ 'document.issue_date': { type: 'date', labels: ['del'] } })

  it('non legge il numero della norma citata', () => {
    const { fact } = extract(numero(), [
      page(['garanzia RC Auto (art. 17 del Decreto Legislativo n. 68 del 6/5/2011).'])
    ])
    expect(fact('document.number').value).toBeNull()
  })

  it('non legge il civico di un indirizzo', () => {
    const { fact } = extract(numero(), [page(['Via G. Carducci, N. 1551 CEREGNANO (RO)'])])
    expect(fact('document.number').value).toBeNull()
  })

  it('non legge la data dellʼatto a cui il documento rimanda', () => {
    const { fact } = extract(data(), [page(['pratica con atto del 06/03/2017'])])
    expect(fact('document.issue_date').value).toBeNull()
  })

  it('non legge il numero del documento a cui si rimanda, anche abbreviato', () => {
    expect(
      extract(numero(), [page(['Riferim. fattura n. 12'])]).fact('document.number').value
    ).toBeNull()
    expect(
      extract(numero(), [page(['Riferimento fattura n. 12'])]).fact('document.number').value
    ).toBeNull()
  })

  it('quello che è del documento continua a leggersi', () => {
    const { fact } = extract(numero(), [page(['FATTURA n. 114/2026 del 08/09/2026'])])
    expect(fact('document.number').value).toBe('114/2026')
  })

  it('la riga buona vince anche se il documento ne cita unʼaltra prima', () => {
    const { fact } = extract(data(), [
      page(['(ai sensi del D.Lgs. 9 aprile 2008, n. 81)', 'Emesso del 16/12/2025'])
    ])
    expect(fact('document.issue_date').value).toBe('2025-12-16')
  })

  it('un campo che cita di mestiere legge la citazione: è il suo valore', () => {
    const registry = registryOf({
      'hse.legal_basis': { type: 'string', labels: ['riferimento normativo'] }
    })
    const { fact } = extract(registry, [
      page(['Riferimento normativo: D.Lgs. 9 aprile 2008, n. 81'])
    ])
    expect(fact('hse.legal_basis').value).not.toBeNull()
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

  it('una riga presa da un’etichetta più specifica non è un secondo candidato', () => {
    const registry = registryOf({
      'bank.iban': { type: 'identifier', format: 'iban', labels: ['iban'] },
      'payment.debit_account': {
        type: 'identifier',
        format: 'account_number',
        labels: ['iban ordinante']
      }
    })
    const lines = [
      'IBAN ordinante: IT60X0542811101000000123456',
      'IBAN: IT41W8000000292100645211151'
    ]
    const { fact, result } = extract(registry, [page(lines)])
    expect(fact('payment.debit_account').value).toBe('IT60X0542811101000000123456')
    // Il documento dice di chi è la prima riga: l'IBAN del beneficiario resta uno solo.
    expect(fact('bank.iban')).toMatchObject({
      value: 'IT41W8000000292100645211151',
      reviewStatus: 'AUTO_ACCEPTED'
    })
    expect(result.conflicts).toEqual([])

    // Senza il campo che se la prende, le due righe restano due candidati alla pari.
    const alone = extract(
      registryOf({ 'bank.iban': { type: 'identifier', format: 'iban', labels: ['iban'] } }),
      [page(lines)]
    )
    expect(alone.fact('bank.iban').reviewStatus).toBe('CONFLICT')
    expect(alone.result.conflicts).toEqual(['MULTIPLE_CANDIDATES:bank.iban'])
  })
})

describe('partita IVA e codice fiscale in campi distinti', () => {
  /** Le due chiavi di una parte, con le etichette che hanno nel registry. */
  const fiscal = (party: string) =>
    registryOf({
      [`${party}.vat_number`]: {
        type: 'identifier',
        format: 'vat_number',
        labels: ['partita iva', 'p.iva', 'p. iva'],
        validators: ['vat_number_format']
      },
      [`${party}.tax_code`]: {
        type: 'identifier',
        format: 'italian_tax_code',
        labels: ['codice fiscale', 'c.f.', 'cod. fisc.'],
        validators: ['italian_tax_code_format']
      }
    })

  it('«C.F. e P.IVA» su una riga: lo stesso numero è di tutti e due, senza conflitto', () => {
    for (const line of [
      'C.F. e P.IVA 12345678903',
      'P.IVA/C.F. IT12345678903',
      'Codice fiscale e partita IVA: 12345678903'
    ]) {
      const { fact, result } = extract(fiscal('issuer'), [page([line])])
      expect(fact('issuer.vat_number'), line).toMatchObject({
        value: '12345678903',
        reviewStatus: 'AUTO_ACCEPTED'
      })
      expect(fact('issuer.tax_code'), line).toMatchObject({
        value: '12345678903',
        reviewStatus: 'AUTO_ACCEPTED'
      })
      expect(result.conflicts, line).toEqual([])
    }
  })

  it('codice fiscale di persona e partita IVA sulla stessa riga vanno ognuno al suo campo', () => {
    const { fact } = extract(fiscal('issuer'), [page(['C.F. RSSMRA80A01H501U P.IVA 12345678903'])])
    expect(fact('issuer.tax_code').value).toBe('RSSMRA80A01H501U')
    expect(fact('issuer.vat_number').value).toBe('12345678903')
  })

  it('la partita IVA non legge un codice fiscale di persona', () => {
    // Una ditta individuale che scrive solo il codice fiscale sotto l'etichetta doppia.
    const { fact } = extract(fiscal('issuer'), [page(['C.F./P.IVA: RSSMRA80A01H501U'])])
    expect(fact('issuer.tax_code').value).toBe('RSSMRA80A01H501U')
    expect(fact('issuer.vat_number')).toMatchObject({ value: null, reviewStatus: 'MISSING' })
    expect(readIdentifier(': IT12345678903', 'vat_number')).toBe('12345678903')
    expect(readIdentifier(': RSSMRA80A01H501U', 'vat_number')).toBeNull()
  })

  it('gemelli solo dentro la stessa parte', () => {
    expect(fiscalTwinOf('issuer.vat_number')).toBe('issuer.tax_code')
    expect(fiscalTwinOf('company.tax_code')).toBe('company.vat_number')
    expect(fiscalTwinOf('issuer.tax_id')).toBeNull()
    expect(fiscalTwinOf('employment.employee_tax_code')).toBeNull()

    // Partita IVA dell'emittente e codice fiscale dell'impresa non sono la stessa cosa.
    const registry = registryOf({
      'issuer.vat_number': { type: 'identifier', format: 'vat_number', labels: ['p.iva'] },
      'company.tax_code': { type: 'identifier', format: 'italian_tax_code', labels: ['cod fis'] }
    })
    const { fact } = extract(registry, [page(['Cod. Fis. e P.IVA 12345678903'])])
    expect(fact('company.tax_code')).toMatchObject({ value: '12345678903' })
    expect(fact('issuer.vat_number')).toMatchObject({ value: null })
  })

  it('con il registry vero, sulla fattura: la stessa riga non dice di quale parte è', () => {
    const result = extractFactsV2({
      documentType: 'accounting.fattura',
      pages: [
        page([
          'ALFA S.R.L.',
          'C.F. e P.IVA 12345678903',
          'Spett.le',
          'BETA S.P.A.',
          'P.IVA 98765432103'
        ])
      ],
      registry: testRegistryV2()
    })
    const fact = (id: string) => result.facts.find((f) => f.fieldId === id)!
    // Emittente e destinatario hanno le stesse etichette: il motore non indovina, segnala.
    // Il codice fiscale segue la sua partita IVA, anche nel conflitto.
    for (const id of [
      'issuer.vat_number',
      'issuer.tax_code',
      'recipient.vat_number',
      'recipient.tax_code'
    ]) {
      expect(fact(id), id).toMatchObject({ value: '12345678903', reviewStatus: 'CONFLICT' })
    }
    expect(result.conflicts).toContain('SHARED_EVIDENCE:issuer.vat_number|recipient.vat_number')
  })

  it('con il registry vero, sulla visura: codice fiscale, partita IVA e REA', () => {
    const read = (lines: string[]) => {
      const result = extractFactsV2({
        documentType: 'corporate_registry.visura_camerale',
        pages: [page(lines)],
        registry: testRegistryV2()
      })
      return (id: string) => result.facts.find((f) => f.fieldId === id)!
    }
    const fact = read([
      'Registro Imprese Codice fiscale e numero di iscrizione: 12345678903',
      'Numero REA RO - 160649',
      'Data iscrizione REA 12/03/2010',
      'Partita IVA 12345678903',
      'Amministratore unico',
      'Codice fiscale RSSMRA80A01H501U'
    ])
    // L'etichetta lunga è dell'impresa: il codice fiscale dell'amministratore non le fa
    // concorrenza, e il valore non va in conflitto.
    expect(fact('company.tax_code')).toMatchObject({
      value: '12345678903',
      reviewStatus: 'AUTO_ACCEPTED'
    })
    expect(fact('company.vat_number')).toMatchObject({
      value: '12345678903',
      reviewStatus: 'AUTO_ACCEPTED'
    })
    expect(fact('company.rea_number')).toMatchObject({
      value: 'RO - 160649',
      reviewStatus: 'AUTO_ACCEPTED'
    })

    // La forma del certificato camerale, e una ditta individuale col codice di persona.
    const individual = read([
      'Codice fiscale e n. iscrizione al Registro Imprese RSSMRA80A01H501U',
      'Partita IVA 12345678903'
    ])
    expect(individual('company.tax_code').value).toBe('RSSMRA80A01H501U')
    expect(individual('company.vat_number').value).toBe('12345678903')
  })

  it('il numero REA con la provincia, come lo scrive la visura', () => {
    expect(readIdentifier(' RO - 160649', 'rea_number')).toBe('RO - 160649')
    expect(readIdentifier(': RO-160649.', 'rea_number')).toBe('RO - 160649')
    expect(readIdentifier(' n. RO 160649', 'rea_number')).toBe('RO - 160649')
    expect(readIdentifier(' 160649', 'rea_number')).toBe('160649')
    // Novara, non «numero».
    expect(readIdentifier(' NO - 123456', 'rea_number')).toBe('NO - 123456')
    expect(readIdentifier(' nr 160649', 'rea_number')).toBe('160649')
    // Una data dopo l'etichetta non è un REA.
    expect(readIdentifier(' 12/03/2010', 'rea_number')).toBeNull()
    expect(readIdentifier(' 12.03.2010', 'rea_number')).toBeNull()
    expect(readIdentifier(' iscritta dal 2010', 'rea_number')).toBeNull()
  })
})

describe('cognome e nome distinti sui documenti d’identità', () => {
  /**
   * Con il registry vero: le etichette sono quelle degli hint. Le righe sono ricostruite
   * sul modello della carta d'identità elettronica e del permesso di soggiorno, non prese
   * da un documento: l'export del 18/09 non porta il testo delle pagine.
   */
  const read = (documentType: string, pages: ExtractedPage[]) => {
    const result = extractFactsV2({ documentType, pages, registry: testRegistryV2() })
    return { result, fact: (id: string) => result.facts.find((f) => f.fieldId === id)! }
  }
  const CARTA = 'identity_personal.carta_identita'
  const PERMESSO = 'identity_personal.permesso_di_soggiorno'

  it('«Nome» non si trova dentro «Cognome», né «Name» dentro «Surname»', () => {
    // Due regole lo tengono fuori: l'etichetta si cerca a confini di parola, e il testo
    // libero la vuole in testa al segmento. Basta una delle due; il test cade senza entrambe.
    const spec = testRegistryV2().field('person.first_name')!
    expect(readsOfLabel('person.first_name', spec, [{ text: 'COGNOME: ROSSI' }], 'Nome')).toEqual(
      []
    )
    expect(readsOfLabel('person.first_name', spec, [{ text: 'SURNAME: ROSSI' }], 'Name')).toEqual(
      []
    )
    expect(readsOfLabel('person.first_name', spec, [{ text: 'NOME: MARIO' }], 'Nome')).toEqual([
      { line: 0, valueLine: 0, sameLine: true, labelEnd: 4, value: 'MARIO' }
    ])
  })

  it('carta elettronica: etichette bilingui su righe proprie, valore sotto', () => {
    const front = page([
      'REPUBBLICA ITALIANA',
      "MINISTERO DELL'INTERNO",
      'CARTA DI IDENTITÀ / IDENTITY CARD',
      'CA00000AA',
      'COMUNE DI / MUNICIPALITY',
      'ROVIGO',
      'COGNOME / SURNAME',
      'ROSSI',
      'NOME / NAME',
      'MARIO',
      'LUOGO E DATA DI NASCITA / PLACE AND DATE OF BIRTH',
      'ROMA (RM) 01.01.1980',
      'SESSO / SEX STATURA / HEIGHT CITTADINANZA / NATIONALITY',
      'M 180 ITA',
      'EMISSIONE / ISSUING SCADENZA / EXPIRY',
      '05.07.2022 05.07.2033',
      "FIRMA DEL TITOLARE / HOLDER'S SIGNATURE"
    ])
    // Sul retro «NOME» e «NAME» tornano dentro un'altra etichetta: non sono il nome.
    const back = page(
      [
        'CODICE FISCALE / FISCAL CODE',
        'RSSMRA80A01H501U',
        'INDIRIZZO DI RESIDENZA / RESIDENCE',
        'VIA ROMA 1, ROVIGO (RO)',
        'COGNOME, NOME DEI GENITORI O DI CHI NE FA LE VECI / SURNAME AND NAME OF PARENTS',
        'ROSSI GIUSEPPE'
      ],
      2
    )
    const { result, fact } = read(CARTA, [front, back])
    expect(fact('person.last_name')).toMatchObject({
      value: 'ROSSI',
      evidence: [{ page: 1, text: 'COGNOME / SURNAME\nROSSI' }]
    })
    expect(fact('person.first_name')).toMatchObject({
      value: 'MARIO',
      evidence: [{ page: 1, text: 'NOME / NAME\nMARIO' }]
    })
    expect(fact('person.address').value).toBe('VIA ROMA 1, ROVIGO (RO)')
    // Emissione e scadenza stanno affiancate, e il lettore non sa in che colonna è il
    // valore: la scadenza resta vuota invece di prendere la data di emissione.
    expect(fact('document.expiry_date').value).toBeNull()
    expect(result.conflicts).toEqual([])
  })

  it('la coda in un’altra lingua non riempie la riga: il valore sta sotto', () => {
    // Senza spazi intorno alla barra la riga non è più l'etichetta composta che gli hint
    // dichiarano, ed è la forma in cui l'OCR la restituisce più spesso.
    const { fact } = read(CARTA, [
      page(['CITTADINANZA/NATIONALITY', 'ITA', 'COGNOME/SURNAME', 'ROSSI'])
    ])
    expect(fact('identity.nationality')).toMatchObject({
      value: 'ITA',
      evidence: [{ page: 1, text: 'CITTADINANZA/NATIONALITY\nITA' }]
    })
    expect(fact('person.last_name').value).toBe('ROSSI')
  })

  it('una coda che non è un’altra lingua dello stesso campo resta una riga piena', () => {
    // «Quantità» non è come questo campo si chiama in un'altra lingua: è l'intestazione
    // della colonna accanto, e la riga sotto è il primo dato della tabella, non il valore.
    const registry = registryOf({
      'line_item.description': { type: 'string', labels: ['descrizione'] }
    })
    const { fact } = extract(registry, [page(['Descrizione / Quantità', 'Cemento 32,5 R'])])
    expect(fact('line_item.description').value).toBeNull()
  })

  it('valore accanto all’etichetta: coi due punti si legge, senza resta vuoto', () => {
    for (const lines of [
      ['Cognome: ROSSI', 'Nome: MARIO'],
      ['Nome: MARIO', 'Cognome: ROSSI']
    ]) {
      const { fact } = read(CARTA, [page(lines)])
      expect(fact('person.last_name'), lines.join(' | ')).toMatchObject({
        value: 'ROSSI',
        reviewStatus: 'AUTO_ACCEPTED'
      })
      expect(fact('person.first_name'), lines.join(' | ')).toMatchObject({
        value: 'MARIO',
        reviewStatus: 'AUTO_ACCEPTED'
      })
    }
    // Il testo libero vuole i due punti sulla stessa riga, **tranne** dopo un'etichetta
    // ripetuta in un'altra lingua: lì i due punti non arrivano mai e il valore è quello che
    // segue. Quello che resta vietato è prendersi il campo accanto.
    const { fact } = read(CARTA, [page(['COGNOME / SURNAME ROSSI', 'NOME / NAME MARIO'])])
    expect(fact('person.last_name').value).toBe('ROSSI')
    expect(fact('person.first_name').value).toBe('MARIO')
  })

  it('con le colonne fuse ogni campo si ferma dove comincia il successivo', () => {
    // Come l'OCR restituisce una tessera: più coppie etichetta/valore su una riga sola.
    const { fact } = read(CARTA, [page(['COGNOME/SURNAME ROSSI NOME/NAME MARIO'])])
    expect(fact('person.last_name').value).toBe('ROSSI')
    expect(fact('person.first_name').value).toBe('MARIO')

    // «SESSO» e «STATURA» non sono campi del profilo, ma sono scritti bilingui come tutte
    // le intestazioni di questo modulo: la cittadinanza si ferma lì lo stesso.
    const fuse = read(CARTA, [
      page(['CITTADINANZA/NATIONALITY ITA SESSO/SEX M STATURA/HEIGHT 175'])
    ])
    expect(fuse.fact('identity.nationality').value).toBe('ITA')
  })

  it('una barra dentro il valore non lo taglia', () => {
    // `1/A` non è una parola bilingue: servono almeno tre lettere per lato.
    const registry = registryOf({
      'person.address': { type: 'string', labels: ['indirizzo', 'address'] }
    })
    const { fact } = extract(registry, [page(['INDIRIZZO/ADDRESS VIA ROMA 1/A, ROVIGO'])])
    expect(fact('person.address').value).toBe('VIA ROMA 1/A, ROVIGO')
  })

  it('una frase con «nome» e «cognome» non è né l’uno né l’altro', () => {
    const { fact } = read(CARTA, [
      page([
        'Cognome e nome: ROSSI MARIO',
        'Nome e cognome del padre: ROSSI GIUSEPPE',
        'Il sottoscritto, nome del dichiarante: BIANCHI'
      ])
    ])
    expect(fact('person.last_name').value).toBeNull()
    expect(fact('person.first_name').value).toBeNull()
  })

  it('se l’OCR perde il cognome, il cognome resta vuoto e non prende l’etichetta del nome', () => {
    for (const lines of [
      ['COGNOME / SURNAME', 'NOME / NAME', 'MARIO'],
      ['COGNOME', 'NOME', 'MARIO']
    ]) {
      const { fact } = read(CARTA, [page(lines)])
      expect(fact('person.last_name'), lines.join(' | ')).toMatchObject({
        value: null,
        reviewStatus: 'MISSING'
      })
      expect(fact('person.first_name').value, lines.join(' | ')).toBe('MARIO')
    }
  })

  it('permesso di soggiorno: etichette in italiano, valore sotto', () => {
    const { result, fact } = read(PERMESSO, [
      page([
        'PERMESSO DI SOGGIORNO',
        'COGNOME',
        'AYAD',
        'NOME',
        'HAMID',
        'NAZIONALITÀ',
        'MAR',
        'DATA DI RILASCIO',
        '28.06.2023',
        'SCADENZA',
        '29.07.2026'
      ])
    ])
    expect(fact('person.last_name').value).toBe('AYAD')
    expect(fact('person.first_name').value).toBe('HAMID')
    expect(fact('identity.nationality').value).toBe('MAR')
    // Rilascio e scadenza sulle chiavi generiche, con le etichette di `identity.*`.
    expect(fact('document.issue_date').value).toBe('2023-06-28')
    expect(fact('document.expiry_date').value).toBe('2026-07-29')
    expect(result.facts.map((f) => f.fieldId)).not.toContain('person.name')
    expect(result.conflicts).toEqual([])
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

/**
 * Su una nota di credito gli importi possono essere negativi: il profilo del tipo toglie
 * `non_negative_money` da totale, imponibile e imposta (`field_validator_overrides`). Su una
 * fattura il validatore dell'ontologia resta, e un totale negativo va rivisto.
 */
describe('validatori decisi dal profilo del tipo', () => {
  const registry = testRegistryV2()
  const lines = [
    'Totale imponibile: -1.000,00',
    'Totale IVA: -220,00',
    'Totale documento: -1.220,00'
  ]
  const run = (documentType: string) => {
    const result = extractFactsV2({ documentType, pages: [page(lines)], registry })
    return (id: string) => result.facts.find((f) => f.fieldId === id)!
  }

  it('sulla nota di credito un importo negativo non è un errore', () => {
    const fact = run('accounting.nota_di_credito')
    for (const [id, value] of [
      ['money.total', '-1220.00'],
      ['money.taxable', '-1000.00'],
      ['money.tax', '-220.00']
    ] as const) {
      expect(fact(id)).toMatchObject({
        value,
        confidence: CONFIDENCE_SAME_LINE,
        reviewStatus: 'AUTO_ACCEPTED',
        validationErrors: []
      })
    }
  })

  it('sulla fattura lo stesso totale negativo va rivisto', () => {
    const fact = run('accounting.fattura')
    expect(fact('money.total')).toMatchObject({
      value: '-1220.00',
      reviewStatus: 'NEEDS_REVIEW',
      validationErrors: ['NEGATIVE_MONEY']
    })
  })
})

/**
 * La provenienza non cambia niente di quello che viene proposto: è quello che resta scritto
 * accanto alla proposta per poterla spiegare dopo. Serve alla misura della fase 2, dove un
 * numero deludente va smontato per capire quale parte l'ha prodotto.
 */
describe('la provenienza della lettura', () => {
  const learned = (fieldId: string, label: string, scope: 'TEMPLATE' | 'CLASS') => ({
    ruleId: `rule-${label}`,
    fieldId,
    label,
    relation: 'same-line' as const,
    scope
  })

  it('dice con quale delle due letture il valore è stato preso', () => {
    const registry = registryOf({
      'issuer.name': { type: 'string', labels: ['emittente'] },
      'recipient.name': { type: 'string', labels: ['destinatario'] }
    })
    const { fact } = extract(registry, [
      page(['Emittente: Alfa S.r.l.', 'Destinatario:', 'Beta Costruzioni S.p.A.'])
    ])
    expect(fact('issuer.name').evidence[0]).toMatchObject({ strategy: 'LABEL_STRICT' })
    expect(fact('recipient.name').evidence[0]).toMatchObject({ strategy: 'NEXT_LINE' })
  })

  it('un’etichetta del registry non ha un ambito da dichiarare', () => {
    const registry = registryOf({ 'issuer.name': { type: 'string', labels: ['emittente'] } })
    const { fact } = extract(registry, [page(['Emittente: Alfa S.r.l.'])])
    // Dietro non c'è nessuna regola appresa: scriverci `CLASS` farebbe sembrare imparato
    // quello che il registry sapeva già, e la misura conterebbe un merito che non c'è.
    expect(fact('issuer.name').evidence[0]?.ruleScope).toBeUndefined()
  })

  it('un’etichetta imparata porta l’ambito con cui la regola valeva', () => {
    const registry = registryOf({ 'money.total': { type: 'money', labels: [] } })
    const scopeOf = (scope: 'TEMPLATE' | 'CLASS') =>
      extractFactsV2({
        documentType: 'test.tipo',
        pages: [page(['Saldo EUR 900,00'])],
        registry,
        learnedLabels: [learned('money.total', 'saldo', scope)]
      }).facts[0]?.evidence[0]
    expect(scopeOf('TEMPLATE')).toMatchObject({ ruleId: 'rule-saldo', ruleScope: 'TEMPLATE' })
    expect(scopeOf('CLASS')).toMatchObject({ ruleId: 'rule-saldo', ruleScope: 'CLASS' })
  })

  it('su un campo ripetuto ogni riga porta la sua', () => {
    const registry = registryOf({ line_items: { type: 'string', labels: ['voce'], many: true } })
    const { fact } = extract(registry, [page(['Voce: Fornitura', 'Voce:', 'Posa in opera'])])
    expect(fact('line_items').evidence.map((e) => e.strategy)).toEqual([
      'LABEL_STRICT',
      'NEXT_LINE'
    ])
  })
})

describe('le date e il conto di un bonifico', () => {
  /**
   * Con il registry vero: le etichette sono quelle degli hint. Le righe sono ricostruite
   * sul modello di una ricevuta di bonifico online, non prese da un documento: l'export
   * del 18/09 non porta il testo delle pagine.
   */
  const read = (lines: string[]) => {
    const result = extractFactsV2({
      documentType: 'banking.ricevuta_bonifico',
      pages: [page(lines)],
      registry: testRegistryV2()
    })
    return { result, fact: (id: string) => result.facts.find((f) => f.fieldId === id)! }
  }

  it('le tre date stanno in tre campi, e nessuna è «Data operazione»', () => {
    const { result, fact } = read([
      'RICEVUTA DI BONIFICO',
      'Data inserimento: 11/03/2026',
      'Data esecuzione: 12/03/2026',
      'Data valuta beneficiario: 13/03/2026',
      'Importo: 1.250,00 EUR'
    ])
    expect(fact('payment.entry_date')).toMatchObject({
      value: '2026-03-11',
      reviewStatus: 'AUTO_ACCEPTED'
    })
    expect(fact('payment.execution_date').value).toBe('2026-03-12')
    expect(fact('payment.value_date').value).toBe('2026-03-13')
    // `finance.transaction_date` è uscito dal profilo: «Data operazione» su una ricevuta è
    // una di quelle tre, e il revisore ci scriveva la data di esecuzione.
    expect(result.facts.map((f) => f.fieldId)).not.toContain('finance.transaction_date')
    expect(result.conflicts).toEqual([])
  })

  it('il conto da cui parte: IBAN a gruppi di quattro o numero di rapporto', () => {
    const iban = read(['Conto di addebito: IT60 X054 2811 1010 0000 0123 456'])
    expect(iban.fact('payment.debit_account').value).toBe('IT60X0542811101000000123456')

    const rapporto = read(['Numero rapporto: 000012345678'])
    expect(rapporto.fact('payment.debit_account').value).toBe('000012345678')
  })

  it('l’IBAN della ricevuta è del beneficiario, quello dell’ordinante è il conto di addebito', () => {
    const { result, fact } = read([
      'Ordinante: ALFA S.R.L.',
      'IBAN ordinante: IT60X0542811101000000123456',
      'Beneficiario: BETA S.P.A.',
      'IBAN: IT41W8000000292100645211151'
    ])
    // L'etichetta più lunga vince sulla riga dell'ordinante: `bank.iban` non la prende.
    expect(fact('payment.debit_account').value).toBe('IT60X0542811101000000123456')
    expect(fact('bank.iban')).toMatchObject({
      value: 'IT41W8000000292100645211151',
      reviewStatus: 'AUTO_ACCEPTED'
    })
    expect(result.conflicts).toEqual([])
  })

  it('«Valuta» da sola è la moneta, «Data valuta» è una data', () => {
    const { fact } = read(['Valuta: EUR', 'Data valuta: 13/03/2026'])
    expect(fact('money.currency').value).toBe('EUR')
    expect(fact('payment.value_date').value).toBe('2026-03-13')
  })
})

describe('la scadenza della formazione si calcola', () => {
  /**
   * Con il registry vero. Le righe sono ricostruite sul modello di un attestato di
   * formazione generale: l'export del 18/09 non porta il testo delle pagine, ma porta i
   * valori che il revisore ha scritto su `6ad7d267`.
   */
  const read = (documentType: string, lines: string[]) => {
    const result = extractFactsV2({
      documentType,
      pages: [page(lines)],
      registry: testRegistryV2()
    })
    return { result, fact: (id: string) => result.facts.find((f) => f.fieldId === id)! }
  }
  const GENERALE = 'hse_training.attestato_formazione_generale'

  const ATTESTATO = [
    'ATTESTATO DI FREQUENZA',
    'Formazione generale dei lavoratori',
    'Rossi Mario',
    'Data emissione: 13/05/2021',
    'Data formazione: 04/05/2021'
  ]

  it('il documento non la scrive: il motore la deduce, e si vede che è dedotta', () => {
    const { fact } = read(GENERALE, ATTESTATO)
    expect(fact('hse.training_expiry')).toMatchObject({
      value: '2026-05-13',
      computed: true,
      evidence: [],
      reviewStatus: 'NEEDS_REVIEW'
    })
    expect(fact('hse.training_expiry').confidence).toBe(CONFIDENCE_COMPUTED)
    // Gli altri campi restano letti: la deduzione non tocca niente che fosse nel documento.
    expect(fact('document.issue_date').value).toBe('2021-05-13')
    expect(fact('document.issue_date').computed).toBeUndefined()
  })

  it('una scadenza scritta sul documento vince sempre', () => {
    const { fact } = read(GENERALE, [...ATTESTATO, 'Scadenza formazione: 30/06/2026'])
    expect(fact('hse.training_expiry')).toMatchObject({
      value: '2026-06-30',
      reviewStatus: 'AUTO_ACCEPTED'
    })
    expect(fact('hse.training_expiry').computed).toBeUndefined()
  })

  it('senza la data di rilascio non si deduce niente', () => {
    const { fact } = read(GENERALE, ['ATTESTATO DI FREQUENZA', 'Data formazione: 04/05/2021'])
    expect(fact('hse.training_expiry')).toMatchObject({ value: null, reviewStatus: 'MISSING' })
  })

  it('un corso che la tabella non conosce resta senza scadenza', () => {
    const { fact } = read('hse_training.attestato_preposto', ATTESTATO)
    expect(fact('hse.training_expiry').value).toBeNull()
  })
})
