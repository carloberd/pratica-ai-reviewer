/**
 * Quando un numero o una data appartengono a qualcosa che il documento **cita**, e non al
 * documento.
 *
 * Nell'export del 18/09/2026 due terzi degli errori di valore del motore stavano su
 * `document.number` e `document.issue_date`, e quasi tutti avevano la stessa forma: il
 * lettore trovava un'etichetta generica — «n.», «del» — dentro una citazione, e leggeva
 * quello che seguiva.
 *
 * ```
 * (ai sensi del D.Lgs. 9 aprile 2008, n. 81)      -> data emissione 2008-04-09
 * garanzia RC Auto (art. 17 del D.Lgs. n. 68 ...) -> numero documento 68
 * Via G. Carducci, N. 1551 CEREGNANO (RO)         -> numero documento 1551
 * pratica con atto del 06/03/2017                 -> data emissione 2017-03-06
 * Rif.to Ns. Offerta n.3260/26 del 16/06/2026     -> data emissione 2026-06-16
 * ```
 *
 * Tre famiglie: la norma citata, l'indirizzo — dove il civico si legge come un numero di
 * documento — e il rimando a un altro documento.
 *
 * Qui si lavora sul testo **ripiegato** (minuscole, senza accenti, punteggiatura ridotta a
 * spazi), quello che i due lettori già usano per cercare le etichette.
 */

/**
 * Le parole della norma citata. Contano **da tutte e due le parti** dell'etichetta: in
 * «ai sensi **del** D.Lgs. 9 aprile 2008» la citazione comincia dopo «del», e senza
 * guardare avanti quella data finirebbe in `document.issue_date`.
 */
export const NORM_MARKERS = new Set([
  'art',
  'artt',
  'articolo',
  'articoli',
  'comma',
  'decreto',
  'legge',
  'dlgs',
  'lgs',
  'dpr',
  'dm',
  'dl',
  'direttiva',
  'regolamento',
  'circolare'
])

/**
 * Le parole che contano **solo davanti** all'etichetta: dicono di che cosa è il numero che
 * le segue, ma dopo l'etichetta non vogliono dire niente. Guardarle anche in avanti
 * scarterebbe «Data emissione: 12/09/2026 — Via Roma 5».
 */
export const PRECEDING_MARKERS = new Set([
  // L'indirizzo. Non `strada`: «codice della strada» è più comune di «Strada Provinciale»,
  // e quella citazione la coprono già `codice` e `art`.
  'via',
  'viale',
  'vicolo',
  'piazza',
  'piazzale',
  'corso',
  'largo',
  // Il rimando a un altro documento.
  'atto',
  'deposito',
  'rif',
  // «Riferim. fattura n. 12»: l'abbreviazione lunga, che il ripiegamento non riduce a `rif`.
  'riferim',
  'riferimento',
  'ns',
  'vs'
])

/** Tutte le parole che segnalano una citazione, da qualunque parte dell'etichetta stiano. */
export const REFERENCE_MARKERS = new Set([...NORM_MARKERS, ...PRECEDING_MARKERS])

/**
 * Quante parole prima dell'etichetta si guardano. Oltre, la citazione è finita e quello
 * che si legge torna a essere del documento: in «Visti gli artt. 1-5-6-7 del Nuovo Codice
 * della Strada, il presente provvedimento del 22/09/2022» il secondo «del» è buono.
 *
 * Si contano solo le parole di lettere. I numeri di una citazione — «D.Lgs. 9 aprile 2008,
 * n. 81», «artt. 1-5-6-7 del…» — si mangerebbero la finestra prima di arrivare alla parola
 * che dice di che citazione si tratta.
 */
export const REFERENCE_WINDOW = 3

/**
 * L'etichetta cade dentro una citazione.
 *
 * Guarda {@link REFERENCE_WINDOW} parole prima — dove sta qualunque marcatore — e
 * altrettante dopo, dove contano solo quelli della norma.
 *
 * `foldedStart` è l'indice nel testo ripiegato **con uno spazio davanti**, come lo
 * restituisce la ricerca a confini di parola dei due lettori.
 */
export function precededByReference(folded: string, foldedStart: number, label = ''): boolean {
  const before = folded.slice(0, Math.max(0, foldedStart - 1))
  if (nearWords(before, 'last').some((word) => REFERENCE_MARKERS.has(word))) return true

  const after = folded.slice(Math.max(0, foldedStart - 1) + label.length + 1)
  return nearWords(after, 'first').some((word) => NORM_MARKERS.has(word))
}

/**
 * La riga cita qualcosa, dovunque.
 *
 * Serve dove non c'è un'etichetta su cui ancorarsi — il ripiego della v1, che prende la
 * prima data o il primo numero della prima pagina — e lì basta che la riga sia una
 * citazione perché quel valore non sia del documento.
 */
export function mentionsReference(folded: string): boolean {
  return folded.split(' ').some((word) => REFERENCE_MARKERS.has(word))
}

/**
 * Il campo cita di mestiere — «Riferimento normativo», «Estremi dell'atto» — e per lui la
 * citazione non è un errore ma il valore.
 *
 * Lo dicono le sue etichette, non una lista a parte: un campo nuovo che si chiama così è
 * già coperto senza che nessuno si ricordi di aggiungerlo.
 */
export function readsReferences(foldedLabels: string[]): boolean {
  return foldedLabels.some(mentionsReference)
}

/** Le parole di lettere più vicine all'etichetta, da un lato o dall'altro. */
function nearWords(folded: string, side: 'first' | 'last'): string[] {
  const words = folded.split(' ').filter((word) => /[a-z]/.test(word))
  return side === 'last' ? words.slice(-REFERENCE_WINDOW) : words.slice(0, REFERENCE_WINDOW)
}
