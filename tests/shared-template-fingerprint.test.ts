import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEMPLATE_SIMILARITY_THRESHOLD,
  NORMALIZED_TEMPLATE_SIGNATURE_ALGORITHM,
  normalizedTemplateFeature,
  normalizedTemplateSignature,
  parseNormalizedTemplateSignature,
  TEMPLATE_FINGERPRINT_LENGTH,
  TEMPLATE_HEADER_LINES,
  templateFingerprint,
  templateLine,
  templateSignatureSimilarity
} from '../src/shared/template-fingerprint'

/** Lo stesso stampato, compilato due volte con dati diversi. */
const PRIMA = [
  'ALFA COSTRUZIONI S.R.L.',
  'Via Garibaldi 12 - 40100 Bologna',
  'FATTURA n. 114/2026 del 08/09/2026',
  'Cliente: Beta Immobiliare S.p.A.',
  'Totale documento EUR 86.420,00'
]

const SECONDA = [
  'ALFA COSTRUZIONI S.R.L.',
  'Via Garibaldi 12 - 40100 Bologna',
  'FATTURA n. 27/2026 del 14/09/2026',
  'Cliente: Gamma Immobiliare S.r.l.',
  'Totale documento EUR 4.900,50'
]

/** Un altro stampato: altre righe, altre etichette. */
const ALTRO_STAMPATO = [
  'COMUNE DI BOLOGNA',
  'CERTIFICATO DI DESTINAZIONE URBANISTICA',
  'Protocollo 2026/0004512 del 08/09/2026',
  'Foglio 12 particella 340'
]

/**
 * La stessa visura camerale estratta due volte a distanza di mesi: stessa azienda, altra
 * data di richiesta, altro protocollo, e un socio in più nel corpo. È il caso che si
 * ripete davvero in archivio, e su cui l'algoritmo precedente si rompeva: la riga della
 * richiesta e quella del protocollo hanno un numero diverso di gruppi di cifre, e lì la
 * forma della riga era ancora il dato.
 */
const VISURA_MARZO = [
  'CAMERA DI COMMERCIO INDUSTRIA ARTIGIANATO E AGRICOLTURA DI VENEZIA ROVIGO',
  'Registro Imprese - Archivio ufficiale della CCIAA',
  "VISURA ORDINARIA SOCIETA' DI CAPITALE",
  'POLESINE MASSETTI S.R.L.S.',
  'DATI ANAGRAFICI',
  'Indirizzo Sede legale:  ROVIGO (RO) VIA DELLA COSTITUZIONE 5 CAP 45100',
  'Codice fiscale e n.iscr. al Registro Imprese:  01552340295',
  'Documento n. T 512398234  del  19/03/2026',
  'Soci e titolari di diritti su azioni e quote: 2'
]

const VISURA_SETTEMBRE = [
  'CAMERA DI COMMERCIO INDUSTRIA ARTIGIANATO E AGRICOLTURA DI VENEZIA ROVIGO',
  'Registro Imprese - Archivio ufficiale della CCIAA',
  "VISURA ORDINARIA SOCIETA' DI CAPITALE",
  'POLESINE MASSETTI S.R.L.S.',
  'DATI ANAGRAFICI',
  'Indirizzo Sede legale:  ROVIGO (RO) VIA DELLA COSTITUZIONE 5 CAP 45100',
  'Codice fiscale e n.iscr. al Registro Imprese:  01552340295',
  'Documento n. T 601122905  del  17/09/2026',
  'Soci e titolari di diritti su azioni e quote: 3'
]

/** Un'altra azienda, stesso stampato della camera di commercio. */
const VISURA_ALTRA_AZIENDA = [
  ...VISURA_MARZO.slice(0, 3),
  'B.C. COSTRUZIONI SRL',
  ...VISURA_MARZO.slice(4)
]

describe('etichette della riga', () => {
  it('tiene quello che viene prima dei due punti', () => {
    expect(templateLine('Cliente: Beta Immobiliare S.p.A.')).toBe('cliente')
    expect(templateLine('Codice fiscale e n.iscr. al Registro Imprese:  01552340295')).toBe(
      'codice fiscale iscr registro imprese'
    )
  })

  it('tiene quello che viene prima della colonna', () => {
    expect(templateLine('Indirizzo Sede legale   ROVIGO (RO) VIA DELLA COSTITUZIONE 5')).toBe(
      'indirizzo sede legale'
    )
    expect(templateLine('Imponibile\t4.900,50')).toBe('imponibile')
  })

  it('senza separatore tiene la riga, e butta comunque i numeri', () => {
    expect(templateLine('FATTURA n. 114/2026 del 08/09/2026')).toBe('fattura del')
    expect(templateLine('Totale documento EUR 86.420,00')).toBe('totale documento eur')
  })

  it('una riga che comincia col separatore la si tiene tutta', () => {
    expect(templateLine(': Beta Immobiliare')).toBe('beta immobiliare')
  })

  it('normalizza accenti, maiuscole e punteggiatura', () => {
    expect(templateLine("Societa' a responsabilita' limitata")).toBe(
      'societa responsabilita limitata'
    )
    expect(templateLine('Società à responsabilità limitata')).toBe(
      'societa responsabilita limitata'
    )
  })

  it('una riga di soli dati non lascia etichette', () => {
    expect(templateLine('12/B - 45011 - 01339870293')).toBe('')
    expect(templateLine('86.420,00')).toBe('')
  })
})

describe('impronta del modulo', () => {
  it('stesso stampato con dati diversi: stessa impronta', () => {
    expect(templateFingerprint(SECONDA)).toBe(templateFingerprint(PRIMA))
  })

  it('la stessa visura estratta due volte ha la stessa impronta', () => {
    expect(templateFingerprint(VISURA_SETTEMBRE)).toBe(templateFingerprint(VISURA_MARZO))
  })

  it('un nome proprio senza etichetta davanti separa ancora: è il limite noto', () => {
    expect(templateFingerprint(VISURA_ALTRA_AZIENDA)).not.toBe(templateFingerprint(VISURA_MARZO))
  })

  it('layout diverso: impronta diversa', () => {
    expect(templateFingerprint(ALTRO_STAMPATO)).not.toBe(templateFingerprint(PRIMA))
    expect(templateFingerprint(VISURA_MARZO)).not.toBe(templateFingerprint(PRIMA))
  })

  it('una riga di dati in più non cambia il modulo', () => {
    expect(templateFingerprint([...PRIMA, 'IT60 X054 2811 1010 0000 0123 456'])).toBe(
      templateFingerprint(PRIMA)
    )
  })

  it('unʼetichetta in più sì', () => {
    expect(templateFingerprint([...PRIMA, 'Modalita di pagamento bonifico bancario'])).not.toBe(
      templateFingerprint(PRIMA)
    )
  })

  it('lʼordine delle righe non conta: una riga che scivola non cambia lʼimpronta', () => {
    const scambiate = [PRIMA[1]!, PRIMA[0]!, ...PRIMA.slice(2)]
    expect(templateFingerprint(scambiate)).toBe(templateFingerprint(PRIMA))
  })

  it('il corpo resta fuori: oltre la testata le righe non contano', () => {
    // Una testata piena, così che il corpo cada tutto oltre la finestra.
    const testata = Array.from(
      { length: TEMPLATE_HEADER_LINES },
      (_, i) => PRIMA[i % PRIMA.length]!
    )
    const conCorpo = [...testata, ...Array.from({ length: 10 }, (_, i) => `Riga merce numero ${i}`)]
    const altroCorpo = [...testata, ...Array.from({ length: 10 }, (_, i) => `Voce diversa ${i}`)]
    expect(templateFingerprint(altroCorpo)).toBe(templateFingerprint(conCorpo))
  })

  it('spazi e righe vuote non contano', () => {
    expect(templateFingerprint(['', '   ', ...PRIMA, ''])).toBe(templateFingerprint(PRIMA))
  })

  it('è stabile: sedici caratteri esadecimali, sempre gli stessi', () => {
    const fingerprint = templateFingerprint(PRIMA)!
    expect(fingerprint).toMatch(new RegExp(`^[0-9a-f]{${TEMPLATE_FINGERPRINT_LENGTH}}$`))
    expect(templateFingerprint(PRIMA)).toBe(fingerprint)
  })

  it('senza testo non cʼè impronta: le scansioni non si raggruppano fra loro', () => {
    expect(templateFingerprint([])).toBeNull()
    expect(templateFingerprint(['', '  ', '\n'])).toBeNull()
  })

  it('senza abbastanza etichette non cʼè impronta', () => {
    expect(templateFingerprint(['86.420,00', '12/B', '2026'])).toBeNull()
    expect(templateFingerprint(['Fattura', '2026', '86.420,00'])).toBeNull()
  })
})

describe('firma normalizzata del modulo', () => {
  it('lo stesso stampato compilato due volte è lo stesso modulo', () => {
    const prima = normalizedTemplateSignature(PRIMA)!
    const seconda = normalizedTemplateSignature(SECONDA)!
    expect(templateSignatureSimilarity(prima, seconda)).toBeGreaterThanOrEqual(
      DEFAULT_TEMPLATE_SIMILARITY_THRESHOLD
    )
  })

  it('sopravvive a una riga in più, che all’impronta esatta bastava a separare', () => {
    // È il caso che ha reso lo scope TEMPLATE inutilizzabile: una copia con una riga in
    // più era un altro modulo, e nessuna regola arrivava a due conferme.
    const conCopia = [...PRIMA, 'Copia per archivio']
    expect(templateFingerprint(conCopia)).not.toBe(templateFingerprint(PRIMA))
    expect(
      templateSignatureSimilarity(
        normalizedTemplateSignature(PRIMA),
        normalizedTemplateSignature(conCopia)
      )
    ).toBeGreaterThanOrEqual(DEFAULT_TEMPLATE_SIMILARITY_THRESHOLD)
  })

  it('un altro stampato resta un altro modulo', () => {
    expect(
      templateSignatureSimilarity(
        normalizedTemplateSignature(PRIMA),
        normalizedTemplateSignature(ALTRO_STAMPATO)
      )
    ).toBeLessThan(DEFAULT_TEMPLATE_SIMILARITY_THRESHOLD)
  })

  it('non porta fuori né valori né soggetti: solo hash, e nessuno del dato', () => {
    const firma = normalizedTemplateSignature(PRIMA)!
    expect(firma.algorithm).toBe(NORMALIZED_TEMPLATE_SIGNATURE_ALGORITHM)
    expect(firma.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    for (const feature of firma.features) expect(feature).toMatch(/^[0-9a-f]{16}$/)

    // La ragione sociale e l'indirizzo sono il soggetto, non il modulo: restano fuori,
    // così due documenti dello stesso stampato per clienti diversi coincidono.
    expect(normalizedTemplateFeature('ALFA COSTRUZIONI S.R.L.')).toBeNull()
    expect(normalizedTemplateFeature('Via Garibaldi 12 - 40100 Bologna')).toBeNull()
    // Di una riga etichetta-valore resta l'etichetta, mai il valore.
    expect(normalizedTemplateFeature('Cliente: Beta Immobiliare S.p.A.')).toBe('label:cliente')
  })

  it('firme di algoritmi diversi non si confrontano', () => {
    const firma = normalizedTemplateSignature(PRIMA)!
    const altraVersione = {
      ...firma,
      algorithm: 'reviewer/normalized-template-anchors/sha256-16-v2'
    } as unknown as typeof firma
    expect(templateSignatureSimilarity(firma, altraVersione)).toBe(0)
    expect(templateSignatureSimilarity(firma, null)).toBe(0)
  })

  it('senza ancore non cʼè firma, come per lʼimpronta', () => {
    expect(normalizedTemplateSignature([])).toBeNull()
    expect(normalizedTemplateSignature(['', '  '])).toBeNull()
  })

  it('una firma corrotta disattiva il confronto, non lʼelaborazione', () => {
    expect(parseNormalizedTemplateSignature('{non json')).toBeNull()
    expect(parseNormalizedTemplateSignature('{"algorithm":"altro"}')).toBeNull()
    expect(parseNormalizedTemplateSignature(null)).toBeNull()
    const firma = normalizedTemplateSignature(PRIMA)!
    expect(parseNormalizedTemplateSignature(JSON.stringify(firma))).toEqual(firma)
  })
})
