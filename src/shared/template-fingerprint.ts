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
