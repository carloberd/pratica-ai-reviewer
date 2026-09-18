import { createHash } from 'node:crypto'

/**
 * Impronta del modulo da cui esce un documento.
 *
 * L'idea è togliere i dati e tenere lo stampato: due visure della stessa camera di
 * commercio hanno ragioni sociali, indirizzi e codici diversi ma le stesse intestazioni,
 * quindi la stessa impronta. Un altro stampato — altre intestazioni — ne ha una diversa.
 *
 * Non è una firma crittografica di nulla: è una chiave di raggruppamento, e serve al
 * learner per contare quante volte ha visto lo stesso modulo, e all'export per le stesse
 * ragioni.
 *
 * ## Perché non è la forma delle righe
 *
 * Fino alla 1.5.1 l'impronta era lo sha-256 di *tutte* le righe della prima pagina con le
 * lettere ridotte a `A` e le cifre a `9`. Mascherare i caratteri non basta: quello che
 * resta — quante parole ha la riga, quanti gruppi di cifre, dove cadono i segni — è
 * ancora il dato. Due visure dello stesso stampato divergono sulla riga della ragione
 * sociale (`A A A.A.A.A.` contro `A.A. A A`), su quella dell'indirizzo e su quella della
 * forma giuridica; e siccome l'hash copriva la pagina intera, una riga diversa bastava.
 *
 * Il risultato, misurato sull'export del 18/09/2026: **ogni impronta corrispondeva a un
 * solo documento** — tre visure, tre impronte — e nessuna regola di scope TEMPLATE
 * poteva arrivare a `minTemplateSupport: 2`. Era un'identità di documento, non di modulo.
 *
 * ## Cosa si tiene adesso
 *
 * L'*etichetta* di ogni riga della testata, non la riga intera. In questi PDF la riga che
 * esce da pdfjs è spesso «etichetta, poi il valore»: separati da due punti
 * (`Cliente: Beta Immobiliare S.p.A.`) o dallo spazio della colonna
 * (`Indirizzo Sede legale····ROVIGO (RO) VIA DELLA COSTITUZIONE 5`). Si tiene quello che
 * viene prima del separatore, e di quello le sole parole senza cifre: `cliente`,
 * `indirizzo sede legale`. Una riga senza separatore la si tiene tutta, sempre senza le
 * cifre: `FATTURA n. 114/2026 del 08/09/2026` diventa `fattura del`.
 *
 * Si guardano le prime {@link TEMPLATE_HEADER_LINES} righe non vuote. Le intestazioni di
 * uno stampato non cambiano da una compilazione all'altra; il corpo sì — le righe della
 * fattura, i soci della visura — e infatti resta fuori.
 *
 * Le righe si ordinano e si deduplicano prima dell'hash: una riga di dati che scivola in
 * mezzo alla testata, o una sola intestazione che va a capo diversamente, non deve
 * cambiare l'impronta. Raggruppare troppo costa poco — le chiavi delle regole portano
 * già il tipo di documento, quindi due moduli diversi finiti sotto la stessa impronta
 * restano separati — mentre raggruppare troppo poco, come si è visto, non fa imparare
 * niente.
 *
 * ## Quello che ancora non separa
 *
 * Un nome proprio su una riga tutta sua resta dentro: la ragione sociale in testa a una
 * visura non ha un'etichetta davanti, quindi due visure della stessa camera di commercio
 * ma di aziende diverse hanno ancora impronte diverse. Due visure della *stessa* azienda,
 * che è il caso che si ripete davvero in archivio, adesso coincidono. Quello che si
 * impara da un modulo attraverso soggetti diversi è materia dello scope CLASS.
 *
 * Qui non c'è né database né filesystem: entrano le righe di testo, esce la stringa.
 */

/**
 * Il nome dell'algoritmo, per chi legge un'impronta fuori da qui: un'altra estrazione del
 * testo (il markdown di pratica-ai) darebbe impronte diverse per lo stesso documento.
 *
 * Cambia col cambiare delle regole qui sotto: le impronte scritte da una versione
 * precedente non sono confrontabili con queste, e vanno ricalcolate.
 */
export const TEMPLATE_FINGERPRINT_ALGORITHM = 'reviewer/pdfjs-first-page-labels/sha256-16'

/**
 * Quante righe non vuote della prima pagina fanno testata. Oltre comincia il corpo —
 * le righe della fattura, i soci della visura — che cambia a ogni documento.
 */
export const TEMPLATE_HEADER_LINES = 20

/** Sotto questo numero di righe di etichette non c'è abbastanza testata per un'impronta. */
export const TEMPLATE_MIN_LABEL_LINES = 3

/** Lunghezza minima di una parola perché conti: sotto ci sono «di», «n», «e». */
export const TEMPLATE_MIN_WORD_LENGTH = 3

/** Caratteri esadecimali tenuti dell'hash: abbastanza per non collidere, corti da leggere. */
export const TEMPLATE_FINGERPRINT_LENGTH = 16

/**
 * Separatore fra l'etichetta e il valore su una riga: i due punti, la tabulazione, o lo
 * spazio largo di una colonna. Meno di due spazi è solo spaziatura fra parole.
 */
const LABEL_SEPARATOR = /:|\t|\s{2,}/

/**
 * L'etichetta di una riga: quello che viene prima del separatore, minuscolo, senza
 * accenti, senza punteggiatura, senza le parole che contengono cifre e senza quelle
 * troppo corte per dire qualcosa.
 *
 * «Cliente: Beta Immobiliare S.p.A.» diventa `cliente`, uguale per ogni cliente dello
 * stesso stampato. «Totale documento EUR 86.420,00», che separatore non ne ha, diventa
 * `totale documento eur`. Una riga di soli dati — «45100 - 12/B» — diventa la stringa
 * vuota e sparisce.
 */
export function templateLine(line: string): string {
  const head = line.split(LABEL_SEPARATOR)[0]?.trim()
  return words(head && head !== '' ? head : line)
}

/** Le parole che contano di un frammento: niente cifre, niente parole corte. */
function words(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (word) =>
        word.length >= TEMPLATE_MIN_WORD_LENGTH && !/\p{N}/u.test(word) && /\p{L}/u.test(word)
    )
    .join(' ')
}

/**
 * Le righe da cui si ricava l'impronta: quelle dell'estrazione, o il testo spezzato a capo
 * quando l'estrazione non le ha. Elaborazione ed export devono leggere le stesse, o lo
 * stesso documento avrebbe due impronte.
 */
export function firstPageLines(
  page: { text: string; lines: Array<{ text: string }> } | undefined
): string[] {
  if (!page) return []
  if (page.lines.length > 0) return page.lines.map((line) => line.text)
  return page.text.split(/\r?\n/)
}

/**
 * L'impronta delle etichette della testata, o `null` quando non c'è abbastanza testo da
 * cui ricavarla: una scansione senza OCR non ha un modulo leggibile, e un'impronta uguale
 * per tutte le scansioni raggrupperebbe documenti che non c'entrano niente. Vale lo stesso
 * per una pagina di soli numeri, che di etichette non ne ha.
 */
export function templateFingerprint(lines: string[]): string | null {
  const header = lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, TEMPLATE_HEADER_LINES)

  const labels = [...new Set(header.map(templateLine).filter((line) => line !== ''))].sort()
  if (labels.length < TEMPLATE_MIN_LABEL_LINES) return null

  return createHash('sha256')
    .update(labels.join('\n'), 'utf8')
    .digest('hex')
    .slice(0, TEMPLATE_FINGERPRINT_LENGTH)
}

// ---------------------------------------------------------------------------
// Firma normalizzata: lo stesso modulo, confrontabile per somiglianza
// ---------------------------------------------------------------------------

/**
 * ## Perché l'impronta esatta non basta
 *
 * L'impronta qui sopra è una chiave: due documenti la condividono o no. Misurato
 * sull'export del 18/09/2026, quasi sempre no — **ogni impronta corrispondeva a un solo
 * documento**. La 0013 ha ridotto il problema tenendo le sole etichette della testata, ma
 * non lo toglie: basta una riga che va a capo diversamente, un'intestazione in più su una
 * copia, un campo compilato dove l'altro modulo lo lascia vuoto, e l'insieme delle
 * etichette cambia — quindi cambia l'hash, quindi è un altro modulo.
 *
 * La conseguenza non è cosmetica. `minTemplateSupport` è 2 e `minTemplateTypeSupport` è 3:
 * se un'impronta vale per un documento solo, **nessuna regola di scope `TEMPLATE` può
 * arrivare ad attivarsi**, né per le etichette né per la memoria dei moduli. Lo scope più
 * preciso che il learner ha resta candidato per sempre, e il learner impara solo per tipo.
 *
 * ## Cosa fa la firma
 *
 * Invece di una chiave sola, tiene anche **l'insieme** delle ancore da cui la chiave è
 * ricavata. Due testate possono allora essere confrontate per quante ancore hanno in
 * comune (Jaccard) invece che per uguaglianza: una riga in più fa scendere la somiglianza,
 * non la azzera. Sopra {@link DEFAULT_TEMPLATE_SIMILARITY_THRESHOLD} i due documenti sono
 * lo stesso modulo, e le loro revisioni si sommano sulla stessa regola.
 *
 * Le ancore sono hashate una per una, quindi la firma si può confrontare ed esportare
 * senza portarsi dietro intestazioni, nomi o valori — la stessa disciplina dell'impronta.
 *
 * ## Cosa non fa
 *
 * Non sostituisce l'impronta esatta, le sta accanto: le regole scritte prima della firma
 * hanno solo l'impronta, e continuano a valere per confronto esatto. E non è una misura
 * di rischio — la somiglianza dice quanto due testate si assomigliano, non quanto è grave
 * sbagliare. Chi la usa per proporre un tipo pesa il segnale di conseguenza.
 */
export const NORMALIZED_TEMPLATE_SIGNATURE_ALGORITHM =
  'reviewer/normalized-template-anchors/sha256-16-v1'

/**
 * Quante ancore in comune servono perché due testate siano lo stesso modulo.
 *
 * `0,68` su Jaccard vuol dire che due testate da dieci ancore possono divergerne due per
 * parte e restare lo stesso modulo. È scelto a occhio sui pochi documenti disponibili e
 * **va ritarato sul corpus reale**: troppo basso fonde moduli diversi e insegna regole che
 * non valgono, troppo alto riporta al problema che questa firma esiste per risolvere.
 */
export const DEFAULT_TEMPLATE_SIMILARITY_THRESHOLD = 0.68

export interface NormalizedTemplateSignature {
  algorithm: typeof NORMALIZED_TEMPLATE_SIGNATURE_ALGORITHM
  fingerprint: string
  /** Hash ordinati delle ancore: confrontabili, ma senza testo del documento nell'export. */
  features: string[]
}

/** Forme giuridiche: stanno nella ragione sociale, che è un dato, non il modulo. */
const LEGAL_FORM =
  /\b(?:s\.?\s*r\.?\s*l\.?|s\.?\s*p\.?\s*a\.?|s\.?\s*n\.?\s*c\.?|s\.?\s*a\.?\s*s\.?)\b/i
/** Una riga che comincia con un odonimo è un indirizzo: cambia col soggetto, non col modulo. */
const ADDRESS_LINE = /^(?:via|viale|piazza|corso|largo|strada|loc\.?|localita)\b/i
/** Etichetta e valore su una riga sola, separati da due punti, uguale o trattino spaziato. */
const LABEL_SPLIT = /^(.{2,64}?)(?::|=|\s[-–—]\s)/

/**
 * Un'ancora della testata, o `null` se quella riga non ne porta una.
 *
 * Tre casi, in quest'ordine. Una riga «etichetta: valore» dà l'etichetta e butta il valore,
 * che è il dato. Una riga senza etichetta ma con una ragione sociale o un indirizzo non dà
 * niente: è il soggetto del documento, e due documenti dello stesso modulo per soggetti
 * diversi devono restare lo stesso modulo. Tutto il resto dà il testo con gli identificativi,
 * le date e i numeri sostituiti da segnaposto e poi tolti, troncato a dieci parole.
 */
export function normalizedTemplateFeature(line: string): string | null {
  const compact = line.replace(/\s+/g, ' ').trim()
  if (!compact || ADDRESS_LINE.test(compact)) return null

  const split = LABEL_SPLIT.exec(compact)
  if (split?.[1]) {
    const label = foldTemplateText(split[1])
    return usefulLabel(label) ? `label:${label}` : null
  }

  if (LEGAL_FORM.test(compact)) return null

  const withoutValues = compact
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/gi, ' <id> ')
    .replace(/\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi, ' <id> ')
    .replace(/\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{2}|\d{4})\b/g, ' <date> ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' <date> ')
    .replace(/\b\d[\d.\s]*(?:,\d{1,2})?\b/g, ' <n> ')
    .replace(/\b(?=[A-Z0-9/_-]{8,}\b)(?=[A-Z0-9/_-]*\d)[A-Z0-9][A-Z0-9/_-]{7,}\b/gi, ' <id> ')

  const text = foldTemplateText(withoutValues)
    .split(' ')
    .filter((token) => token !== 'n' && token !== 'id' && token !== 'date')
    .slice(0, 10)
    .join(' ')
  return usefulLabel(text) ? `text:${text}` : null
}

function foldTemplateText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Un'ancora di sole cifre e punteggiatura non dice niente su che modulo sia. */
function usefulLabel(text: string): boolean {
  return text.replace(/[^a-z]/g, '').length >= 3
}

/**
 * La firma della testata, o `null` quando non ci sono ancore da cui ricavarla — le stesse
 * condizioni di {@link templateFingerprint}, e per la stessa ragione.
 *
 * `fingerprint` qui è l'hash dell'insieme: due documenti con le stesse ancore lo
 * condividono, e allora vale come chiave esatta. Chi non lo condivide si confronta con
 * {@link templateSignatureSimilarity}.
 */
export function normalizedTemplateSignature(lines: string[]): NormalizedTemplateSignature | null {
  const header = lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, TEMPLATE_HEADER_LINES)
  const raw = header.map(normalizedTemplateFeature).filter((item): item is string => item !== null)
  const features = [
    ...new Set(
      raw.map((feature) =>
        createHash('sha256')
          .update(feature, 'utf8')
          .digest('hex')
          .slice(0, TEMPLATE_FINGERPRINT_LENGTH)
      )
    )
  ].sort()
  if (features.length === 0) return null
  return {
    algorithm: NORMALIZED_TEMPLATE_SIGNATURE_ALGORITHM,
    fingerprint: createHash('sha256')
      .update(features.join('\n'), 'utf8')
      .digest('hex')
      .slice(0, TEMPLATE_FINGERPRINT_LENGTH),
    features
  }
}

/**
 * Jaccard sulle ancore: 1 lo stesso insieme, 0 nessuna ancora in comune.
 *
 * Due firme di algoritmi diversi non si confrontano e danno 0: cambiare le regole qui sopra
 * cambia il nome dell'algoritmo, e le firme vecchie smettono di somigliare a quelle nuove
 * invece di somigliarsi per caso.
 */
export function templateSignatureSimilarity(
  left: Pick<NormalizedTemplateSignature, 'algorithm' | 'features'> | null | undefined,
  right: Pick<NormalizedTemplateSignature, 'algorithm' | 'features'> | null | undefined
): number {
  if (!left || !right || left.algorithm !== right.algorithm) return 0
  const a = new Set(left.features)
  const b = new Set(right.features)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const feature of a) if (b.has(feature)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

export function isNormalizedTemplateSignature(
  value: unknown
): value is NormalizedTemplateSignature {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<NormalizedTemplateSignature>
  return (
    candidate.algorithm === NORMALIZED_TEMPLATE_SIGNATURE_ALGORITHM &&
    typeof candidate.fingerprint === 'string' &&
    /^[0-9a-f]{16}$/.test(candidate.fingerprint) &&
    Array.isArray(candidate.features) &&
    candidate.features.length > 0 &&
    candidate.features.length <= 512 &&
    candidate.features.every(
      (feature) => typeof feature === 'string' && /^[0-9a-f]{16}$/.test(feature)
    )
  )
}

/**
 * La firma letta dal database. Un JSON corrotto o scritto da un algoritmo che non c'è più
 * disattiva il confronto per somiglianza — la regola resta, e vale per impronta esatta —
 * invece di far cadere l'elaborazione.
 */
export function parseNormalizedTemplateSignature(
  json: string | null | undefined
): NormalizedTemplateSignature | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    return isNormalizedTemplateSignature(parsed) ? parsed : null
  } catch {
    return null
  }
}
