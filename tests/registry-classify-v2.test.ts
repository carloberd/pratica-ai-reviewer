import { describe, expect, it } from 'vitest'
import type { RegistryAlias } from '../src/main/registry'
import { matchDocumentTypeV2 } from '../src/main/registry/v2/classify-v2'
import type { ClassifierConfigV2 } from '../src/main/registry/v2/config'
import { containsPhraseV2, normalizeClassifierTextV2 } from '../src/main/registry/v2/normalize'
import { testClassifierConfigV2, testRegistry } from './helpers/registry'

const realConfig = testClassifierConfigV2()
const realAliases = testRegistry().aliases()

/** Stessi default del file reale, classi scritte a mano per isolare ogni regola. */
function configWith(classes: ClassifierConfigV2['classes']): ClassifierConfigV2 {
  return { version: 'test', defaults: { ...realConfig.defaults }, classes }
}

const alias = (documentType: string, phrase: string): RegistryAlias => ({ documentType, phrase })

describe('normalizzazione v2', () => {
  it('separa lettere e cifre, toglie accenti e punteggiatura', () => {
    expect(normalizeClassifierTextV2('CERTIFICAZIONE UNICA2026')).toBe('certificazione unica 2026')
    expect(normalizeClassifierTextV2('Regolarità   contributiva (DURC)')).toBe(
      'regolarita contributiva durc'
    )
    expect(normalizeClassifierTextV2('dell’iscrizione')).toBe("dell'iscrizione")
  })

  it('cerca le frasi a confini di parola', () => {
    expect(containsPhraseV2('Fattura n. 114', 'fattura')).toBe(true)
    expect(containsPhraseV2('Fatturato annuo', 'fattura')).toBe(false)
    expect(containsPhraseV2('qualunque testo', '  ')).toBe(false)
  })
})

describe('decisione', () => {
  it('assegna quando il punteggio supera la soglia e c’è margine sul secondo', () => {
    const result = matchDocumentTypeV2({
      aliases: realAliases,
      pages: ['CERTIFICAZIONE UNICA2026\nCertificazione lavoro dipendente'],
      filename: 'documento.pdf',
      config: realConfig
    })
    expect(result.decision).toBe('ASSIGN')
    expect(result.reason).toBe('OK')
    expect(result.documentType).toBe('fiscal_tax.certificazione_unica')
    expect(result.confidence).toBeGreaterThanOrEqual(realConfig.defaults.auto_assign_threshold)
    expect(result.margin).toBeGreaterThanOrEqual(realConfig.defaults.minimum_margin)
  })

  it('un hard negative blocca l’assegnazione anche con un titolo esplicito', () => {
    const config = configWith({
      'certifications_licenses.white_list_prefettura': {
        hard_negative_phrases: ['istanza di permanenza']
      }
    })
    const aliases = [
      alias('certifications_licenses.white_list_prefettura', 'white list prefettura')
    ]

    const decision = matchDocumentTypeV2({
      aliases,
      pages: ['WHITE LIST PREFETTURA\nSi dispone il rinnovo dell’iscrizione'],
      filename: 'white-list.pdf',
      config: configWith({})
    })
    const application = matchDocumentTypeV2({
      aliases,
      pages: ['WHITE LIST PREFETTURA\nIstanza di permanenza nell’elenco'],
      filename: 'white-list.pdf',
      config
    })

    expect(decision.confidence).toBeGreaterThan(application.confidence)
    expect(application.decision).toBe('UNKNOWN')
    expect(application.reason).toBe('HARD_NEGATIVE')
    expect(application.documentType).toBe('')
    expect(application.evidence.some((item) => item.source === 'hard-negative-signal')).toBe(true)
  })

  it('col file reale una richiesta di permanenza non diventa la white list', () => {
    const result = matchDocumentTypeV2({
      aliases: realAliases,
      pages: ['PREFETTURA WHITE LIST\nIstanza di permanenza nell’elenco dei fornitori'],
      filename: 'white-list.pdf',
      config: realConfig
    })
    expect(result.decision).toBe('UNKNOWN')
    expect(result.documentType).not.toBe('certifications_licenses.white_list_prefettura')
  })

  it('una comunicazione di permanenza nella White List non diventa il provvedimento', () => {
    const result = matchDocumentTypeV2({
      aliases: realAliases,
      pages: [
        'COMUNICAZIONE DELL’INTERESSE A PERMANERE NELLA WHITE LIST\nAlla Prefettura - Ufficio Antimafia\nAllegati: documento di identità del sottoscrittore'
      ],
      filename: 'rinnovo-white-list.pdf',
      config: realConfig
    })
    expect(result.decision).toBe('UNKNOWN')
    expect(result.documentType).not.toBe('certifications_licenses.white_list_prefettura')
  })

  // La normalizzazione tiene l'apostrofo: «dell’interesse» resta una parola sola. La frase
  // esclusiva parte dopo, così scatta con l'apostrofo tipografico, con quello dritto e
  // anche quando l'OCR lo perde.
  it.each([
    'COMUNICAZIONE DELL’INTERESSE A PERMANERE NELLA WHITE LIST',
    "COMUNICAZIONE DELL'INTERESSE A PERMANERE NELLA WHITE LIST",
    'COMUNICAZIONE DELL INTERESSE A PERMANERE NELLA WHITE LIST',
    'COMUNICAZIONE DELLINTERESSE A PERMANERE NELLA WHITE LIST'
  ])('col titolo del provvedimento, «%s» resta UNKNOWN', (line) => {
    const result = matchDocumentTypeV2({
      aliases: [alias('certifications_licenses.white_list_prefettura', 'white list prefettura')],
      pages: [`WHITE LIST PREFETTURA\n${line}`],
      filename: 'documento.pdf',
      config: realConfig
    })
    expect(result).toMatchObject({ decision: 'UNKNOWN', reason: 'HARD_NEGATIVE' })
    expect(result.candidates[0]?.evidence).toContainEqual({
      source: 'hard-negative-signal',
      phrase: 'a permanere nella white list',
      delta: -realConfig.defaults.hard_negative_penalty
    })
  })

  it('una frase solo nel nome del file non assegna mai', () => {
    const result = matchDocumentTypeV2({
      aliases: [alias('accounting.fattura', 'fattura')],
      pages: ['testo senza indizi utili'],
      filename: 'Fattura 114.pdf',
      config: configWith({})
    })
    expect(result.decision).toBe('UNKNOWN')
    expect(result.reason).toBe('FILENAME_ONLY')
    expect(result.candidates[0]?.documentType).toBe('accounting.fattura')
  })

  it('due candidati quasi pari restano UNKNOWN per margine insufficiente', () => {
    // Frasi lunghe uguali nel titolo: ciascuna supera la soglia da sola, ma nessuna
    // stacca l'altra.
    const result = matchDocumentTypeV2({
      aliases: [
        alias('contracts_general.contratto_fornitura', 'contratto quadro di fornitura beni'),
        alias('contracts_general.contratto_quadro', 'contratto quadro di fornitura lavori')
      ],
      pages: ['CONTRATTO QUADRO DI FORNITURA BENI\nCONTRATTO QUADRO DI FORNITURA LAVORI'],
      filename: 'contratto.pdf',
      config: configWith({})
    })
    expect(result.confidence).toBeGreaterThanOrEqual(realConfig.defaults.auto_assign_threshold)
    expect(result.decision).toBe('UNKNOWN')
    expect(result.reason).toBe('LOW_MARGIN')
    expect(result.margin).toBeLessThan(realConfig.defaults.minimum_margin)
    expect(result.runnerUp).not.toBeNull()
  })

  it('una frase breve lontana dal titolo resta sotto la soglia', () => {
    const filler = 'x '.repeat(realConfig.defaults.title_zone_chars)
    const result = matchDocumentTypeV2({
      aliases: [alias('payroll_contributions.durc', 'durc')],
      pages: [`${filler}\nsi allega il durc`],
      filename: 'allegato.pdf',
      config: configWith({})
    })
    expect(result.evidence.map((item) => item.source)).toEqual(['page'])
    expect(result.decision).toBe('UNKNOWN')
    expect(result.reason).toBe('BELOW_THRESHOLD')
  })

  it('senza alcun segnale risponde NO_SIGNAL', () => {
    const result = matchDocumentTypeV2({
      aliases: realAliases,
      pages: ['Promemoria interno\nDa archiviare a cura della segreteria.'],
      filename: 'promemoria-ignoto.pdf',
      config: realConfig
    })
    expect(result).toMatchObject({
      decision: 'UNKNOWN',
      reason: 'NO_SIGNAL',
      documentType: '',
      candidates: [],
      runnerUp: null
    })
  })

  it('più frasi concordanti aggiungono un bonus di corroborazione', () => {
    const result = matchDocumentTypeV2({
      aliases: [alias('payroll_contributions.durc', 'durc')],
      pages: ['DURC\nDocumento unico di regolarità contributiva'],
      filename: 'durc.pdf',
      config: configWith({
        'payroll_contributions.durc': {
          positive_phrases: ['documento unico di regolarita contributiva']
        }
      })
    })
    const sources = result.evidence.map((item) => item.phrase)
    expect(sources).toContain('__corroboration__')
    expect(result.decision).toBe('ASSIGN')
  })

  it('un segnale contrario abbassa il fratello sbagliato', () => {
    const scoreOf = (text: string) =>
      matchDocumentTypeV2({
        aliases: realAliases,
        pages: [text],
        filename: 'unilav.pdf',
        config: realConfig
      }).candidates.find((c) => c.documentType === 'hr_employment.unilav_proroga')

    const clean = scoreOf('UNILAV PROROGA\nproroga del rapporto di lavoro')
    const confused = scoreOf('UNILAV PROROGA\nproroga del rapporto di lavoro, data cessazione')

    expect(confused?.evidence).toContainEqual({
      source: 'negative-signal',
      phrase: 'cessazione',
      delta: -realConfig.defaults.negative_penalty
    })
    expect(clean!.score - confused!.score).toBeCloseTo(realConfig.defaults.negative_penalty, 5)
  })

  it('legge solo le prime max_pages pagine', () => {
    const config = configWith({})
    const pages = ['copertina', 'indice', 'FATTURA n. 114']
    expect(config.defaults.max_pages).toBeLessThan(pages.length)
    const result = matchDocumentTypeV2({
      aliases: [alias('accounting.fattura', 'fattura')],
      pages,
      filename: 'documento.pdf',
      config
    })
    expect(result.reason).toBe('NO_SIGNAL')
  })
})

describe('profili di segnali delle classi problematiche', () => {
  const classes = Object.entries(realConfig.classes)

  it('il file reale ne configura 17', () => {
    expect(classes).toHaveLength(17)
  })

  it.each(classes)('%s legge i propri segnali positivi, contrari ed esclusivi', (type, profile) => {
    // Un candidato a zero non compare fra i candidati e le sue evidenze non si vedono.
    // Il test guarda quali frasi vengono lette, non quanto pesano: le penalità scendono
    // a un centesimo, così nessuna somma di frasi contrarie ed esclusive azzera il
    // punteggio (la White List, con tre contrarie e due esclusive, andrebbe sotto zero
    // anche col titolo più forte).
    const title = 'intestazione di prova numero uno'
    const phrases = [
      ...(profile.positive_phrases ?? []),
      ...(profile.negative_phrases ?? []),
      ...(profile.hard_negative_phrases ?? [])
    ]
    const result = matchDocumentTypeV2({
      aliases: [alias(type, title)],
      pages: [[title, ...phrases].join('\n')],
      filename: 'documento.pdf',
      config: {
        ...realConfig,
        defaults: { ...realConfig.defaults, negative_penalty: 0.01, hard_negative_penalty: 0.01 },
        classes: { [type]: profile }
      }
    })
    const candidate = result.candidates.find((c) => c.documentType === type)
    const seen = (source: string) =>
      candidate?.evidence.filter((item) => item.source === source).map((item) => item.phrase) ?? []

    expect(seen('positive-signal').filter((p) => p !== '__corroboration__')).toEqual(
      profile.positive_phrases ?? []
    )
    expect(seen('negative-signal')).toEqual(profile.negative_phrases ?? [])
    expect(seen('hard-negative-signal')).toEqual(profile.hard_negative_phrases ?? [])
  })

  it('non mette in gara i duplicati ritirati del registry', () => {
    // Export del 21/09/2026: due fatture elettroniche native finivano in LOW_MARGIN perché
    // `accounting.fattura` (0,990) e il ritirato `accounting.fattura_elettronica` (0,945)
    // distavano meno di `minimum_margin`. Col v2 quel margine costa tutti i campi.
    const result = matchDocumentTypeV2({
      aliases: realAliases,
      pages: ['FATTURA ELETTRONICA\nN. 114/2026 del 08/09/2026\nCedente prestatore'],
      filename: 'FATTURA ELETTRONICA MRG.pdf',
      config: realConfig
    })

    expect(result.decision).toBe('ASSIGN')
    expect(result.documentType).toBe('accounting.fattura')
    expect(result.candidates.some((c) => c.documentType === 'accounting.fattura_elettronica')).toBe(
      false
    )
  })

  it('lascia una carta d’identità sola in gara, anche se la soglia resta da superare', () => {
    // Stesso export: `carta_identit` e `carta_identita` pareggiavano esatti (0,727 e 0,727).
    // Tolto il ritirato il pareggio sparisce; la soglia è un problema a sé.
    const result = matchDocumentTypeV2({
      aliases: realAliases,
      pages: ['REPUBBLICA ITALIANA\nCARTA DI IDENTITA\nCOMUNE DI ROVIGO'],
      filename: "CARTA IDENTITA'.pdf",
      config: realConfig
    })

    expect(result.candidates.map((c) => c.documentType)).toEqual([
      'identity_personal.carta_identita'
    ])
    expect(result.runnerUp).toBeNull()
    expect(result.reason).not.toBe('LOW_MARGIN')
  })
})

describe('segnali presi dal pilota su documenti reali', () => {
  const run = (text: string) =>
    matchDocumentTypeV2({
      aliases: realAliases,
      pages: [text],
      filename: 'documento.pdf',
      config: realConfig
    })
  const candidateOf = (text: string, type: string) =>
    run(text).candidates.find((c) => c.documentType === type)

  it('le didascalie fronte e retro portano la patente di guida, senza assegnarla da sole', () => {
    const result = run('FRONTE PATENTE\nRETRO PATENTE')
    expect(result.candidates[0]?.documentType).toBe('identity_personal.patente_di_guida')
    expect(result.decision).toBe('UNKNOWN')
    expect(result.reason).toBe('BELOW_THRESHOLD')
  })

  it('una didascalia della carta elettronica basta a staccare la soglia', () => {
    // L'alias da solo vale 0,727 contro una soglia di 0,74: nell'export del 21/09/2026
    // nessuna carta d'identità si assegnava da sola. Una didascalia del modulo decide.
    const solo = run('REPUBBLICA ITALIANA\nCARTA DI IDENTITA\nCOMUNE DI ROVIGO')
    expect(solo.decision).toBe('UNKNOWN')
    expect(solo.reason).toBe('BELOW_THRESHOLD')

    const conDidascalie = run(
      'REPUBBLICA ITALIANA\nCARTA DI IDENTITA\nCOMUNE DI/MUNICIPALITY ROVIGO\nSTATURA/HEIGHT 175'
    )
    expect(conDidascalie.decision).toBe('ASSIGN')
    expect(conDidascalie.documentType).toBe('identity_personal.carta_identita')
  })

  it('le didascalie della carta non si attaccano agli altri documenti d’identità', () => {
    // «cittadinanza nationality» e «repubblica italiana» sono su tutti e tre, e infatti
    // non sono segnali: passaporto e permesso non devono prendere punti dalla carta.
    const passaporto =
      'REPUBBLICA ITALIANA\nPASSAPORTO / PASSPORT\nCOGNOME/SURNAME ROSSI\nCITTADINANZA/NATIONALITY ITA'
    expect(candidateOf(passaporto, 'identity_personal.carta_identita')).toBeUndefined()
    expect(run(passaporto).candidates[0]?.documentType).toBe('identity_personal.passaporto')

    const permesso = 'PERMESSO DI SOGGIORNO\nCOGNOME/SURNAME ROSSI\nCITTADINANZA/NATIONALITY MAR'
    expect(candidateOf(permesso, 'identity_personal.carta_identita')).toBeUndefined()
  })

  it('una dichiarazione di copia conforme qualunque non diventa una patente di guida', () => {
    const text =
      'DICHIARAZIONE SOSTITUTIVA DELL’ATTO DI NOTORIETÀ\nIl sottoscritto dichiaro che la fotocopia allegata è conforme all originale\nIl presente documento e conforme all originale'
    expect(candidateOf(text, 'identity_personal.patente_di_guida')).toBeUndefined()
    expect(run(text).decision).toBe('UNKNOWN')
  })

  // Frasi del pilota che descrivono un'azienda, un generatore di PDF o un altro documento,
  // non il tipo: da sole non devono proporre la classe (docs/pilota_reale_todo.md, punto 2).
  it.each([
    ['identity_personal.patente_di_guida', 'dichiaro che la fotocopia'],
    ['identity_personal.patente_di_guida', 'presente documento e conforme all originale'],
    ['corporate_registry.visura_camerale', 'esito evasione protocollo'],
    ['corporate_registry.visura_camerale', 'numero rea'],
    ['accounting.nota_di_credito', 'riepilogo iva imponibile imposte'],
    ['sales_customers.rapportino_intervento', 'commessa durata'],
    ['sales_customers.rapportino_intervento', 'ricetta'],
    ['sales_customers.rapportino_intervento', 'costo del lavoro'],
    ['hr_payroll.prospetto_costo_del_personale', 'trasferta fuori'],
    ['hr_payroll.prospetto_costo_del_personale', 'ferie dal al'],
    ['hr_payroll.prospetto_costo_del_personale', 'dimissioni assente'],
    ['hr_payroll.prospetto_costo_del_personale', 'autista caposquadra']
  ])('%s non si accende su «%s»', (type, phrase) => {
    expect(candidateOf(`Documento interno\n${phrase}`, type)).toBeUndefined()
  })

  it('una fattura con numero REA e riepilogo IVA resta fuori da visura e nota di credito', () => {
    const text = 'FATTURA\nNumero REA MI-123456\nRiepilogo IVA Imponibile Imposte'
    expect(candidateOf(text, 'corporate_registry.visura_camerale')).toBeUndefined()
    expect(candidateOf(text, 'accounting.nota_di_credito')).toBeUndefined()
  })

  // «nota di credito nr» è anche la forma con cui una fattura cita una nota. Come segnale
  // positivo faceva diventare nota di credito, fino al 99%, una fattura che la citava vicino
  // al titolo: un tipo plausibile e sbagliato. La frase è stata tolta; senza, la fattura
  // resta sotto soglia e chi annota sceglie il tipo.
  it.each([
    'FATTURA\nFattura nr. 12 del 01/03/2026\nRif. nota di credito nr. 5',
    'FATTURA\nRif. nota di credito nr. 5',
    'Fattura n. 12 del 01/03/2026\nRif. nota di credito nr. 5\nCliente Rossi Srl'
  ])('una fattura che cita una nota di credito non diventa una nota di credito (%j)', (text) => {
    const result = run(text)
    expect(result.documentType).not.toBe('accounting.nota_di_credito')
    expect(result.decision).toBe('UNKNOWN')
    expect(
      candidateOf(text, 'accounting.nota_di_credito')?.evidence.map((item) => item.source)
    ).not.toContain('positive-signal')
  })

  it('su una nota di credito «fattura nr» costa la penalità dei segnali contrari', () => {
    const clean = candidateOf(
      'NOTA DI CREDITO\nNota di credito nr. 5',
      'accounting.nota_di_credito'
    )
    const citing = candidateOf(
      'NOTA DI CREDITO\nNota di credito nr. 5\nA storno della fattura nr. 12',
      'accounting.nota_di_credito'
    )
    expect(citing?.evidence).toContainEqual({
      source: 'negative-signal',
      phrase: 'fattura nr',
      delta: -realConfig.defaults.negative_penalty
    })
    expect(clean!.score - citing!.score).toBeGreaterThan(0)
  })

  it('le quattro frasi della quietanza assegnano anche senza titolo', () => {
    const result = run(
      'Modello F24\nQuietanza di versamento\nEstremi del versamento\nProtocollo telematico saldo delega\nDettaglio dei tributi'
    )
    expect(result).toMatchObject({
      decision: 'ASSIGN',
      documentType: 'fiscal_tax.quietanza_versamento'
    })
  })
})

describe('memoria dei moduli già revisionati', () => {
  const memory = (documentType: string) => [{ documentType, templateFingerprint: 'f1' }]

  it('da sola porta il tipo esattamente alla soglia: basta a proporlo', () => {
    const result = matchDocumentTypeV2({
      aliases: [],
      pages: ['Promemoria interno\nData: 12/09/2026'],
      filename: 'promemoria.pdf',
      config: configWith({}),
      templateMemory: memory('payments_treasury.richiesta_pagamento')
    })
    expect(result).toMatchObject({
      decision: 'ASSIGN',
      reason: 'OK',
      documentType: 'payments_treasury.richiesta_pagamento',
      confidence: realConfig.defaults.auto_assign_threshold
    })
    expect(result.evidence).toEqual([
      {
        source: 'template-memory',
        phrase: 'modulo f1',
        delta: realConfig.defaults.auto_assign_threshold
      }
    ])
  })

  it('non passa sopra un hard negative', () => {
    const result = matchDocumentTypeV2({
      aliases: [],
      pages: ['Istanza di permanenza nella white list'],
      filename: 'istanza.pdf',
      config: configWith({
        'certifications_licenses.white_list_prefettura': {
          hard_negative_phrases: ['istanza di permanenza']
        }
      }),
      templateMemory: memory('certifications_licenses.white_list_prefettura')
    })
    expect(result).toMatchObject({ decision: 'UNKNOWN', reason: 'HARD_NEGATIVE' })
  })

  it('non vince un margine insufficiente', () => {
    const result = matchDocumentTypeV2({
      aliases: [alias('accounting.fattura', 'fattura commerciale elettronica')],
      // Un titolo specifico porta la fattura a 0,73: la memoria del modulo vale 0,74.
      pages: ['FATTURA COMMERCIALE ELETTRONICA'],
      filename: 'documento.pdf',
      config: configWith({}),
      templateMemory: memory('payments_treasury.richiesta_pagamento')
    })
    expect(result.candidates.map((c) => c.documentType)).toEqual([
      'payments_treasury.richiesta_pagamento',
      'accounting.fattura'
    ])
    expect(result).toMatchObject({ decision: 'UNKNOWN', reason: 'LOW_MARGIN' })
  })

  it('si somma alle frasi del tipo, ma non conta nel bonus di corroborazione', () => {
    const result = matchDocumentTypeV2({
      aliases: [alias('accounting.fattura', 'fattura')],
      pages: ['Fattura allegata alla nota spese'],
      filename: 'documento.pdf',
      config: configWith({}),
      templateMemory: memory('accounting.fattura')
    })
    expect(result.evidence.map((item) => item.source)).toEqual(['title-zone', 'template-memory'])
    expect(result.evidence.some((item) => item.phrase === '__corroboration__')).toBe(false)
    expect(result.confidence).toBe(0.99)
  })
})
