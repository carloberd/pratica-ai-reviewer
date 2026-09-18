# Analisi export del 2026-09-18

Fonti analizzate (`docs/exports/2026-09-18/`):

- `praticaai-dataset-2026-09-18.json` — 43 documenti, formato `praticaai-reviewer/annotated-dataset` 1.3.0
- `praticaai-regole-apprese-2026-09-18.json` — 24 regole e 122 eventi, formato `praticaai-reviewer/learned-rules` 1.1.0
- `praticaai-dataset-2026-09-18.xlsx` — doppione del dataset JSON (2 fogli, stessi documenti)

App 1.5.1, classifier v2 (2.0.0-draft.1), extraction-brain-v2 2.1.0-draft.1, learner local-learner/0.1.0 in modalità `LEARNING`.

## Quadro generale

| | |
|---|---|
| Documenti | 43 (41 revisionati, 2 scartati) |
| Correzioni | 281 → **6,9 per documento** |
| Campi finali | 360 slot, di cui 288 valorizzati |
| Origine dei valori | ENGINE 47 (16%), REVIEWER 229 (80%) |
| Regole apprese | 24, **tutte CANDIDATE, 0 promuovibili** |

L'app a oggi funziona come strumento di data entry assistita: 4 valori su 5 li scrive la persona.

## 1. Il classificatore non propone quasi mai

Su 41 documenti revisionati, **27 sono arrivati alla review senza alcuna proposta di tipo** (`proposed: null`, confidence 0). Quando invece una proposta c'è, è quasi sempre giusta: 12 su 14 corrette (86%), con confidence mediana 0,875 sui successi e 0,805 sui due errori.

Quindi il problema non è la precisione, è la **copertura**. E i 27 casi scoperti non sono spazzatura: sono visure, carte d'identità, preventivi, ricevute di bonifico — tipi che compaiono più volte nel dataset.

I 2 errori veri sono confusioni semantiche fra tipi adiacenti:

- `sales_customers.ordine_cliente` → `procurement.ordine_acquisto` (stesso documento visto dai due lati)
- `accounting.fattura` (0,827) → il revisore ha **tolto** il tipo lasciandolo vuoto, pur avendo poi compilato 15 campi

La confidence separa male: 0,805 sugli errori contro 0,875 sui successi. Non c'è una soglia utilizzabile per l'auto-accettazione con questi numeri.

### ✅ Risolto in parte — PR #25, `bugfix/classifier-coverage-blind-export`

Prima di toccare le soglie serviva sapere *perché* quei 27 documenti non avevano una proposta, e l'export non lo diceva. Il classificatore v2 calcola una lista ordinata di candidati col punteggio e un `reason` (`NO_SIGNAL`, `BELOW_THRESHOLD`, `LOW_MARGIN`, `FILENAME_ONLY`, `HARD_NEGATIVE`) — la scheda di revisione li mostra già — ma il dataset esportato li buttava via: con `decision: UNKNOWN` restava `proposed: null` e nient'altro. Da un export così non si distingue «non ha trovato niente» da «aveva ragione ma si è fermato tre centesimi sotto soglia», e sono due problemi diversi con due rimedi diversi.

Il formato passa a **1.4.0**. `documentType` porta adesso, anche quando il classificatore non assegna:

```jsonc
"decision": "UNKNOWN",
"reason": "BELOW_THRESHOLD",
"margin": 0.19, "threshold": 0.74, "minimumMargin": 0.08,
"candidates": [{ "documentType": "…", "registryId": "…", "score": 0.71, "rank": 1 }],
"chosen": { "rank": 1, "score": 0.71 }
```

`chosen` è la misura che mancava: dov'era finito, fra i candidati, il tipo che il revisore ha poi scelto. `rank: 1` con `decision: UNKNOWN` vuol dire che il classificatore ci aveva preso e l'ha trattenuto per una soglia — quello si recupera tarando. `rank: null` vuol dire che il tipo giusto non era in lista, e abbassare le soglie non lo farebbe comparire: lì servono frasi nuove in `classifier_signals_v2.json`. Le frasi che sostengono i candidati restano fuori dall'export: sono verbatim del documento, e servono a chi revisiona, non a chi misura.

**Quello che resta aperto:** la taratura vera e propria. Questo export è stato prodotto dalla 1.3.0 e non porta i `reason`, quindi la ripartizione dei 27 fra «senza segnali» e «sotto soglia» non è ricostruibile a posteriori. Serve un export nuovo dagli stessi documenti — con la 1.4.0 la domanda ha una risposta in una riga di query.

Verifiche: gate completo verde (649 test); 5 test in `tests/shared-dataset-classification.test.ts` sui cinque casi (sotto soglia col tipo in testa, senza segnali, tipo fuori lista, documento senza tipo, classificatore mai passato), fixture `dataset-export.expected.json` rigenerata, README aggiornato.

## 2. L'estrazione sbaglia per omissione, non per errore

Delle 281 correzioni: **198 FILLED (70%)** — il motore non aveva prodotto nulla — contro 31 CHANGED (11%) e 11 CLEARED (4%).

I campi più spesso lasciati vuoti sono quelli anagrafici di base: `issuer.name` (27), `recipient.name` (21), `document.issue_date` (14), `company.name` (12), `money.currency` (11).

I 31 CHANGED, invece, hanno un pattern preciso e ricorrente — il motore aggancia **il primo numero o la prima data della pagina**:

```
document.number    '200'        -> 'B/2600143'      (aveva preso una quantità da una riga merce)
document.number    '1551'       -> 'CA81933SM'
document.number    '35'         -> '21513'
document.issue_date '1982-01-23' -> '31.05.2024'    (aveva preso una data di nascita)
document.issue_date '1992-04-30' -> '22/09/2022'
issuer.name        'il soggetto ovvero i soggetti dal/i qu...' -> 'FIDITALIA S.P.A.'
```

10 dei 31 CHANGED sono su `document.issue_date` e 8 su `document.number`: **due terzi degli errori di valore stanno in due campi**, ed entrambi hanno la stessa causa. È il punto con il miglior rapporto sforzo/resa.

### ✅ Risolto in parte — PR #26, `bugfix/label-reads-inside-references`

Guardando l'evidenza dietro ognuno dei 18 CHANGED su questi due campi, la causa è più precisa di «prende il primo match»: **il motore legge un'etichetta generica dentro una citazione**. Le etichette di questi due campi finiscono per essere «n» e «del», che compaiono dappertutto:

| evidenza (verbatim dal documento) | letto | corretto in |
|---|---|---|
| `(ai sensi del D.Lgs. 9 aprile 2008, n. 81 e s.m.i.)` | `2008-04-09` | `16/12/2025` |
| `garanzia RC Auto (art. 17 del Decreto Legislativo n. 68 del 6/5/2011)` | `68` | `2022/67284` |
| `Via G. Carducci, N. 1551 CEREGNANO (RO)` | `1551` | `CA81933SM` |
| `pratica con atto del 06/03/2017 Data deposito: 21/03/2017` | `2017-03-06` | `19/03/2026` |
| `Rif.to Ns. Offerta n.3260/26 del 16/06/2026` | `2026-06-16` | `18/06/2026` |

Tre famiglie: la **norma citata**, l'**indirizzo** (dove il civico si legge come numero di documento) e il **rimando a un altro documento**.

Nuovo modulo `src/main/extract/reference-context.ts`, usato da tutti e due i lettori. Quando l'etichetta cade dentro una citazione, la lettura si scarta:

- **indietro** (3 parole di lettere) valgono tutti i marcatori. I numeri non consumano la finestra, o `artt. 1-5-6-7 del…` la esaurirebbe prima di arrivare a `artt`;
- **avanti** valgono solo quelli della norma, perché in «ai sensi **del** D.Lgs. 9 aprile 2008» la citazione comincia *dopo* l'etichetta. I marcatori di indirizzo restano fuori dalla finestra in avanti, o «Data emissione: 12/09/2026 — Via Roma 5» verrebbe scartata a torto;
- un campo che **cita di mestiere** è esente, e lo dice la sua etichetta: `hse.legal_basis` si chiama «Riferimento normativo», quindi per lui la citazione è il valore. Nessuna lista da tenere aggiornata a mano.

Il lettore v1 aveva anche un **ripiego** peggiore: `issue_date` e `document_number` sono gli unici due campi con `fallback: true`, cioè «se nessuna keyword ha funzionato, prendi la prima data / il primo numero della prima pagina». Da lì venivano le date di nascita (`23.01.1982`). Adesso il ripiego salta le righe che citano qualcosa: senza un'etichetta su cui ancorarsi non c'è modo di distinguere, quindi la riga intera è squalificata.

**Quello che resta aperto:** due dei 18 non hanno un marcatore su cui appigliarsi — `Mesi 36 Numero 35 € 50.522,79` e una data di nascita su una riga senza contesto. Allargare la lista per coprirli sarebbe overfitting sui singoli documenti.

Verifiche: gate completo verde (669 test); `tests/extract-reference-context.test.ts` (14 test, righe verbatim dall'export) più 6 test nuovi in `tests/extract-v2-fact-reader.test.ts`. I test dicono anche quello che **deve continuare a leggersi**: `FATTURA n. 114/2026 del 08/09/2026` dà ancora numero e data.

Restano poi 9 documenti revisionati in cui l'estrazione **non è mai partita** (`extraction: null`): tutti e 4 i loro campi sono stati riempiti a mano.

## 3. Il fingerprint dei template rende il learning impossibile

Questo è il blocco più serio. Le 24 regole hanno precisione 1 ma support 1 (22 su 24) o 2 (2 su 24); la policy chiede `minTemplateSupport: 2` e `minClassSupport: 3`. **Nessuna regola raggiunge la soglia.**

Il motivo è strutturale, non una questione di volume. Incrociando gli eventi con i fingerprint:

```
b95db1febc4a5748  1 documento  visura_camerale
e0ddab7f069df816  1 documento  visura_camerale
e47eebc817283ad2  1 documento  visura_camerale
0158d8963bb79783  1 documento  fattura
81a952dc7e35602d  1 documento  fattura
f83632a17b0cf894  1 documento  preventivo
3570755300c63b74  1 documento  preventivo
892880d593050459  1 documento  durc
```

**Ogni fingerprint corrisponde a esattamente un documento.** Tre visure camerali producono tre fingerprint diversi, due fatture ne producono due. L'algoritmo `reviewer/pdfjs-first-page-lines/sha256-16` hasha le righe della prima pagina, che contengono ragione sociale, numero e data — cioè le parti che cambiano a ogni documento. Sta calcolando un'identità di documento, non un'identità di template.

Conseguenza: le 9 regole `EXTRACTION_ANCHOR|TEMPLATE` e le 8 `TEMPLATE_TYPE` **non potranno mai arrivare a support 2**, per quanti documenti si carichino. Le uniche due regole a support 2 sono infatti entrambe di scope CLASS.

Va normalizzato il fingerprint prima di guardare i volumi: tenere solo le etichette ricorrenti (intestazioni, label di campo), mascherando numeri, date e nomi propri.

> **Corretto durante il fix.** La diagnosi qui sopra era imprecisa su un punto: il mascheramento c'era già — `templateLine` riduceva le lettere a `A` e le cifre a `9`. Non bastava, perché quello che resta dopo la maschera — *quante* parole ha la riga e *quanti* gruppi di cifre — è ancora il dato, e l'hash copriva ogni riga della pagina. Due visure della stessa CCIAA divergono su tre righe su otto:
>
> ```
> A A A.A.A.A.              contro  A.A. A A                 (ragione sociale)
> A A A A (A) A A A 9 A 9   contro  A A A A (A) A A 9/A A 9  (indirizzo)
> A A A' A A' A A           contro  A A A' A A' A            (forma giuridica)
> ```
>
> La conclusione — impronta di documento e non di modulo, scope TEMPLATE inutilizzabile — resta valida.

### ✅ Risolto — PR #24, `bugfix/template-fingerprint-over-specific`

Nuovo algoritmo `reviewer/pdfjs-first-page-labels/sha256-16` in `src/shared/template-fingerprint.ts`:

- si guardano le prime 20 righe non vuote (la testata; il corpo cambia a ogni documento e resta fuori);
- di ogni riga si tiene l'**etichetta**, cioè quello che precede i due punti, la tabulazione o lo spazio di colonna: `Cliente: Beta Immobiliare S.p.A.` → `cliente`, `Indirizzo Sede legale····ROVIGO (RO) VIA...` → `indirizzo sede legale`. Senza separatore si tiene la riga intera, sempre senza le parole con cifre: `FATTURA n. 114/2026 del 08/09/2026` → `fattura del`;
- le righe si ordinano e si deduplicano: una riga di dati che scivola in mezzo alla testata non cambia più l'impronta;
- sotto le 3 righe di etichette l'impronta resta `null`, come già per le scansioni senza OCR.

**Limite noto, dichiarato nel codice e nei test:** un nome proprio su una riga tutta sua, senza etichetta davanti — la ragione sociale in testa a una visura — resta dentro. Due visure della stessa camera di commercio ma di aziende diverse hanno ancora impronte diverse. Due estrazioni della *stessa* azienda, che è il caso che si ripete davvero in archivio, adesso coincidono. Il resto è materia dello scope CLASS.

Migrazione `0013_template_fingerprint_labels.sql`: le impronte vecchie non sono confrontabili con le nuove, quindi `documents.template_fingerprint` e `learning_events.template_fingerprint` si azzerano (l'elaborazione e l'export XLSX le ricalcolano dalla copia in cache), e le regole di scope TEMPLATE — appese a impronte che nessun documento avrà più — chiudono `REJECTED` con la loro riga in `learning_actions`.

Verifiche: `pnpm typecheck && pnpm lint && pnpm test` (644 test) e `pnpm build` verdi; 18 test in `tests/shared-template-fingerprint.test.ts` e il test della 0013 in `tests/db-migrations.test.ts`. Non provato nell'app: serve un riscaricamento dei documenti per vedere le impronte nuove in `learning-view`.

C'è anche un caso di overfitting già visibile in una regola CLASS:

```
procurement.preventivo | document.issue_date | label 'massetti' same-line
```

"massetti" è il nome del cliente, non un'etichetta di documento. Come ancora di classe si applicherà a tutti i preventivi, sbagliando su ogni cliente diverso. Servirebbe una stop-list che escluda dai pattern CLASS i token che coincidono con entità estratte dal documento stesso.

### ✅ Risolto — PR #29, `bugfix/class-anchors-overfit-on-entities`

La stop-list non è una lista: si ricava dal documento stesso. Quando una selezione insegna un'ancora, `documentEntityWords` raccoglie le parole dei valori confermati di **tutti gli altri campi** — righe dei campi ripetuti comprese — e un'etichetta fatta solo di quelle parole **non diventa una regola di classe**.

- Di **template** resta: sullo stesso stampato il nome di chi lo emette è parte del modulo, non del dato. È proprio quello che lo scope TEMPLATE serve a catturare.
- Senza impronta e con un'etichetta che è un dato non si impara niente: quella regola varrebbe per un documento solo.
- Basta **una** parola che non sia un dato perché l'etichetta valga per il tipo: `spett le massetti` passa, `massetti` no.
- Il campo dell'ancora resta fuori dall'insieme: la sua etichetta precede il suo valore, quindi non ne fa parte, e toglierlo protegge le etichette buone che somigliano al valore che annunciano — «Spett.le» davanti a una ragione sociale è esattamente questo caso, ed è una delle due sole regole a support 2 dell'export.

Niente elenco di nomi propri da tenere aggiornato: quello che è un dato lo dice il documento.

Verifiche: gate completo verde (698 test); 6 test nuovi in `tests/learning-anchors.test.ts`, di cui uno riproduce verbatim la regola `massetti` dell'export.

## 4. Il learner ha visto un ottavo dei dati

I 122 eventi coprono **11 documenti distinti**, tutti in una sola sessione di oggi (07:49–09:02), un solo attore. Il dataset ha 281 correzioni su 41 documenti: il learner ne ha osservate 122, e le correzioni fatte prima che il logging fosse attivo sono perse per l'apprendimento.

Se le revisioni storiche sono ricostruibili dal dataset, un replay one-shot degli eventi porterebbe subito il support a livelli utili — ma solo dopo aver sistemato il fingerprint, altrimenti si moltiplicano regole a support 1.

### ✅ Risolto — PR #30, `bugfix/learner-missing-review-history`

Le revisioni storiche sono ricostruibili, e non serve passare dal dataset: valori, correzioni e selezioni stanno a database, e da lì si ricava esattamente quello che `submitReview` avrebbe registrato al momento della chiusura.

Nuovo pulsante **«Ripassa le revisioni»** nella scheda Apprendimento, con `src/main/learning-replay.ts` dietro:

- **idempotente** — `learnFromReview` comincia ritirando le prove di quel documento, quindi rilanciarlo non gonfia i contatori;
- vale solo in **LEARNING**: il ripasso è una registrazione come le altre;
- rielabora la coda dei tipi e dei moduli toccati, come fa una promozione.

Migrazione `0014`: `learning_events.replayed_at`. Su un evento ripassato `at` resta il momento in cui il revisore aveva deciso — è quello che conta per la cronologia — e `replayed_at` dice quando la riga è stata scritta. La colonna serve perché `actor` su un evento ripassato è l'account che ha lanciato il ripasso, **non** necessariamente chi aveva chiuso quella revisione: chi ha chiuso non è mai stato salvato sul documento, e un registro append-only che «dice sempre chi l'ha dato» non deve affermare una cosa che non sa. Un evento registrato sul momento ha `replayedAt: null`. Il bundle delle regole apprese passa a 1.2.0.

**L'ordine conta:** va lanciato *dopo* la PR #24, non prima. Con l'impronta vecchia — una per documento — il ripasso non farebbe che moltiplicare regole di template a support 1.

Verifiche: gate completo verde (706 test); `tests/learning-replay.test.ts` (6 test su documenti veri: si revisiona in FROZEN, dove non si registra niente, poi si passa a LEARNING e si ripassa — recupero, `at` contro `replayedAt`, attribuzione, idempotenza su due lanci, l'evento registrato sul momento che non ha data di ripasso, e il ripasso fuori da LEARNING che non registra), più il test della 0014 e uno sul pulsante.

## 5. Problemi di qualità del dataset

**Le date non sono normalizzate.** Su 57 valori data, 45 sono in formato libero e solo 12 in ISO — e la divisione è netta per origine:

```
ENGINE    ISO yyyy-mm-dd   12
REVIEWER  dd/mm/yyyy       25
REVIEWER  dd.mm.yyyy        9
REVIEWER  altro             8   ('31 Maggio 2022', '29 07 2026', '10 11 1994')
REVIEWER  ISO               3
```

Il revisore ricopia la stringa dal documento, il motore emette ISO. Così com'è, questo dataset non è utilizzabile per valutare l'estrazione delle date: ogni confronto motore/verità darà falso negativo. Serve normalizzazione all'inserimento.

Un valore è proprio sbagliato: `identity.expiry_date = 'COMUNE DI ROVIGO'`.

#### ✅ Risolto — PR #27, `bugfix/reviewer-dates-not-normalized`

Le date si normalizzano adesso **all'inserimento**: quello che il revisore scrive in un campo data si salva `yyyy-mm-dd`, come già fa il motore.

- Nuovo `src/shared/date-value.ts`, con l'unico parser di date del progetto: numerico (`16/12/2025`, `31.05.2024`, `05-07-2022`), a spazi (`29 07 2026`), testuale (`31 Maggio 2022`), ISO, e anno a due cifre col pivot POSIX. I due lettori — `heuristics.findDate` e `fact-reader.readDate` — adesso delegano qui invece di avere ciascuno il suo, così non possono divergere.
- Il confronto con la proposta del motore si fa **dopo** la normalizzazione. Se il motore aveva letto `2025-12-16` e il revisore ricopia `16/12/2025`, sono d'accordo, e non è più una correzione: falsi `CHANGED` in meno nel dataset.
- Quale campo è una data lo dice il tipo semantico del profilo v2; sulle righe scritte dal v1, dove la colonna è nulla, lo dice il nome (`_date`).
- **Quello che il revisore ha selezionato resta verbatim** nella sua evidenza: la selezione si confronta col testo scritto, non con quello normalizzato, o normalizzando si sarebbe persa. Nel dataset si vede `value: "2026-09-12"` accanto a `pick.text: "12/09/2026"`.
- Vale anche per le righe dei campi ripetuti — `payment.due_date` è `many` su alcuni tipi.

**Deliberatamente non normalizzato:** quello che non è *tutta* una data resta come scritto. `03/05/2021 (8 ore), 04/05/2021 (8 ore)` su `hse.training_date` si salva intero, perché normalizzarlo vorrebbe dire buttarne via metà. Vale anche per `identity.expiry_date = 'COMUNE DI ROVIGO'`: resta lì, sbagliato ma visibile, invece di sparire in silenzio. Segnalarlo in revisione è un lavoro a parte.

L'export del 18/09 non cambia: la normalizzazione vale da qui in avanti, sui valori scritti dopo questa versione.

Verifiche: gate completo verde (683 test); `tests/shared-date-value.test.ts` (14 test, valori verbatim dall'export), fixture `dataset-export.expected.json` rigenerata.

**I campi `many` non hanno `origin` a livello di campo.**

> **Corretto durante il fix.** Qui l'analisi diceva che i campi `many` non hanno «né `origin` né `evidence`», e che le loro 34 correzioni non sono attribuibili. È sbagliato, e l'errore è istruttivo: `field.origin` esiste solo sui campi `one`, quindi leggerlo su un `many` restituisce `undefined` invece di dare errore, ed è esattamente quello in cui sono cascato. La provenienza c'è, **una per riga**, dentro `items[]`.
>
> I numeri veri, sulle 41 righe dei 19 campi ripetuti: **tutte e 41 hanno `origin: "REVIEWER"`, 18 hanno un `pick`, nessuna ha `evidence`.** Che è un risultato più netto, non più debole: *il motore non ha prodotto una sola riga di `line_items` o `finance.transactions` che sia sopravvissuta alla revisione.* Le liste le compila la persona, riga per riga.

### ✅ Risolto — PR #28, `bugfix/list-field-origin-missing`

Il formato passa a **1.5.0**: anche `DatasetListField` ha adesso un `origin`, che vale per la lista intera — `ENGINE`, `REVIEWER`, `MIXED` quando il revisore ha aggiunto righe alle proposte del motore, `null` quando la lista è vuota. La provenienza riga per riga resta in `items[]`, che è più precisa; questo serve a contare i campi ripetuti come si contano i singoli, senza che un `undefined` li faccia sparire da un conteggio.

Verifiche: gate completo verde (692 test); `tests/shared-dataset-list-origin.test.ts` (9 test: le quattro combinazioni di origine, le righe tolte che non contano, una riga proposta e poi corretta, e i campi singoli che non cambiano), fixture rigenerata, README aggiornato.

**Le `line_items` sono estratte come righe di testo grezze**, non strutturate:

```
"3 |LGICSL60001674 PZ 5x5000 MQ 26,6250 9,100 9,100 242,29 |22 LASTRA GRECATA..."
```

**Poche tracce di dove vengono i valori del revisore.** Rimisurato con attenzione, sui 341 campi singoli:

| | |
|---|---|
| valorizzati | 276 |
| dal motore (`ENGINE`) | 47 — tutti con `evidence` |
| dal revisore (`REVIEWER`) | 229 — 57 con un `pick`, 31 con l'`evidence` del motore accanto |
| senza né `evidence` né `pick` | **135** |

> **Corretto.** Qui l'analisi diceva che «dei 31 `CHANGED` solo 3 hanno un `pick`», e ne concludeva che il revisore riscrive invece di selezionare. **È falso, e la conclusione era rovesciata.** L'ha contestata il revisore stesso, dicendo che seleziona sempre. Ha ragione.
>
> La registrazione della selezione è arrivata con `b44c877`, il **17/09/2026 alle 18:20**. I 30 documenti chiusi prima non hanno una selezione *per costruzione*: l'app non poteva registrarla. Quei «3 su 31» mettevano insieme due popolazioni incompatibili — erano **3 su 3**. È lo stesso errore di poco sopra sui campi ripetuti: leggere un'assenza come un comportamento.

Contando solo le revisioni fatte quando la funzione esisteva (11 documenti, 99 correzioni), il quadro si ribalta:

| | correzioni | con selezione |
|---|---|---|
| `CHANGED` | 3 | **3 — il 100%** |
| `ADDED` | 21 | 18 (86%) |
| `FILLED` | 73 | 54 (74%) |
| `CLEARED` | 2 | 0 — giusto così, svuotare non ha una sorgente |
| **totale** | **99** | **75 (76%)** |

E il taglio che conta davvero è per sorgente del documento:

| sorgente | correzioni | con selezione |
|---|---|---|
| `NATIVE_TEXT` (8 documenti) | 72 | **64 (89%)** |
| `OCR` (3 documenti) | 27 | 11 (41%) |

Su un PDF con testo nativo il revisore seleziona quasi sempre. Il buco è tutto sulle **scansioni**, e un permesso di soggiorno ha chiuso con 0 selezioni su 10 correzioni.

Dei 75 `pick` registrati, 61 sono `AREA_OCR` e 14 `TEXT_SELECTION`; 58 su 75 hanno una `location` utilizzabile.

### Il problema vero, che l'errore stava nascondendo

`recordPick` tiene la selezione solo se il valore salvato coincide **carattere per carattere** col testo selezionato:

```ts
if (!pick || !value || pickValue(pick.text) !== value) return null
```

Su una scansione l'OCR legge male, il revisore sistema il testo — e **correggendolo perde la selezione**. I valori rimasti senza `pick` lo confermano: sono OCR ripulito a mano.

```
identity.expiry_date       '29 07 2026'
person.birth_date          '10 11 1994'
identity.issuing_authority 'REPUBBLICA ITALIANA MINISTERO DEL...'
person.birth_place         'FRAITA (MAR)'
```

Il controllo ha senso per un valore **diverso** — lì la selezione non ne è più l'origine — ma non per un valore **ripulito**: il punto del documento da cui viene è sempre quello, ed è proprio quello che serve al learner per ricavare l'etichetta. Le scansioni sono i documenti su cui il motore lavora peggio, quindi è lì che l'apprendimento servirebbe di più, ed è lì che si perde.

**65 slot core/optional restano vuoti** dopo la review (46 di ruolo `core`), e 5 documenti sono stati chiusi senza tipo, due dei quali con i campi comunque compilati.

## Poscritto — la selezione con l'OCR, ricontrollata il 18/09

Il revisore ha segnalato due dubbi mentre usava l'app, prima di leggere questo report:

> «seleziono spesso con OCR che è più veloce però secondo me lui non lo riconosce […] perché non lo tiene selezionato come fa con il testo»
>
> «se ritocco quello che scrive perché riconosce male la parola secondo me fa sparire la selezione e non impara»
>
> «confermo se correggo fa sparire la selezione; se non correggo mi sembra la mantenga»

Sono due osservazioni diverse, e stanno in piedi tutt'e due. La seconda è il problema qui sopra visto dall'altro lato. La prima è un secondo problema, che questa analisi non aveva visto.

### A. Ripulire un OCR letto male cancella la selezione — confermato

Il percorso è in tre punti, e nessuno dei tre lascia scampo:

- `src/main/field-edits.ts:54` — `recordPick` tiene la selezione solo se `pickValue(pick.text) === value`;
- `src/main/db/dao/evidence.ts:100` — `pruneReviewer` cancella l'evidenza che nessuna correzione cita più;
- `src/renderer/src/components/field-editor.tsx:71` — il campo di testo non rimanda mai indietro la selezione: chiama `onCommit(draft)` e basta.

Per l'app, ripulire una parola letta male è indistinguibile da «l'ho riscritto a mano». E anche se il renderer rimandasse la selezione (terzo punto), il main la rifiuterebbe lo stesso (primo punto), perché il testo non è più quello: servono tutt'e due le correzioni, una sola non basta.

Il comportamento è scritto come voluto in `tests/field-edits.test.ts:299` («riscritto a mano, il valore perde la selezione e l'evidenza sparisce») e nel test che segue. Non è una regressione: è una regola pensata per un caso e applicata a due.

Anche «se non correggo mi sembra la mantenga» è esatto: la selezione salvata diventa un riquadro tratteggiato permanente (`pdfHighlightPicked`), identico per `AREA_OCR` e `TEXT_SELECTION`.

### B. Sulle scansioni la selezione non ha quasi mai una posizione

Qui sta il «non impara», e vale **anche quando il revisore non corregge niente**.

L'OCR di pagina restituisce solo testo: le righe salvate per le scansioni non hanno coordinate (`src/main/extract/text.ts:84`). Senza coordinate `locatePick` non può usare il riquadro disegnato e deve ritrovare il testo del ritaglio dentro il testo della pagina — ma il ritaglio viene riletto a scala 3 (`OCR_SCALE`) e la pagina no. Due letture della stessa area, e quasi mai coincidono.

Sui soli 11 documenti chiusi dopo `b44c877`:

| | pick | con offset | solo righe | senza posizione |
|---|---|---|---|---|
| scansioni (3 doc) | 11 | **1** | 0 | **10** |
| testo nativo (8 doc) | 64 | 49 | 8 | 7 |

La colonna che conta è la prima: `deriveAnchor` scarta tutto quello che non ha `charStart` (`src/main/learning-anchors.ts:73`), quindi le 58 `location` registrate diventano **50 selezioni da cui si può imparare, e una sola viene da una scansione**. Le 24 regole apprese lo confermano: vengono da visure, DURC, preventivi e fatture — **nessuna** dai quattro tipi scansionati (attestato di formazione, carta d'identità, permesso di soggiorno, PSC).

Sulle scansioni, inoltre, 16 valori su 27 non hanno **nessun** pick, contro 6 su 70 sul testo nativo. Dall'export non si distingue «scritto a mano» da «selezionato e poi ripulito» — quell'assenza da sola non prova niente (è l'errore corretto in §5) — ma il meccanismo del punto A, confermato dal revisore, la spiega per intero.

### C. Anche sul testo nativo, l'area OCR conserva meno della selezione testo

Delle 61 selezioni ad area, **50 sono state fatte su pagine che il testo ce l'hanno**: `captureArea` rasterizza e manda a tesseract in ogni caso, anche quando sotto il riquadro c'è un text layer perfettamente leggibile (`src/renderer/src/components/pdf-viewer.tsx:211`).

| sul testo nativo | pick | con offset | solo righe | senza posizione |
|---|---|---|---|---|
| `AREA_OCR` | 50 | 37 (74%) | 6 | **7** |
| `TEXT_SELECTION` | 14 | 12 (86%) | 2 | 0 |

Lo strumento più veloce è anche quello che conserva meno: ri-leggere i pixel introduce uno scarto dal testo su cui il motore lavorerà, e quello scarto è esattamente ciò che `locatePick` non riesce più a ricucire. È il «non lo riconosce» della segnalazione, misurato.

Un caso resta senza spiegazione: sulla `Visura Camerale - Rakosiova-1.pdf` 5 selezioni su 6 perdono **ogni** posizione, su una pagina con testo nativo ed estratta lo stesso giorno. Perché `locatePick` esca senza nemmeno le righe, il riquadro disegnato non deve toccare nessuna riga con `bbox`: o quelle righe non hanno coordinate, o i due sistemi di coordinate non coincidono su quel PDF. Per dirlo serve il file.

### Le tre cose da fare

1. **Area su pagina con text layer: leggere il testo, non i pixel.** Risolve il problema alla radice per 50 selezioni su 61: testo esatto (niente da ripulire, quindi niente selezione da perdere), offset esatti, e per giunta senza il giro dell'OCR. È anche la più economica: il riquadro e il text layer sono già entrambi nel renderer.
2. **Ripulire un OCR non deve cancellare la selezione.** Tenere pagina e riquadro come provenienza anche quando il revisore sistema il testo, registrando che il testo letto è stato corretto; il controllo carattere per carattere resta per un valore *diverso*, dove la selezione davvero non ne è più l'origine. Tocca i tre punti del §A insieme, e va con i test di riproduzione scritti per questo controllo.
3. **OCR con le coordinate delle parole.** `tesseract.js` le restituisce; oggi `ocr-worker` tiene solo il testo. Con le righe di pagina dotate di `bbox`, `locatePick` torna a lavorare per sovrapposizione anche sulle scansioni, e il learner smette di essere cieco proprio sui documenti su cui il motore va peggio.

L'ordine è questo: il punto 1 toglie la maggior parte delle occasioni di sbagliare, il 2 salva quelle che restano, il 3 riapre l'apprendimento sulle scansioni.

## Dove intervenire, in ordine

1. **Fingerprint del template** — normalizzare prima di hashare. Senza questo l'intero ramo TEMPLATE del learner è codice morto.
2. **Copertura del classificatore** — 27 documenti su 41 senza proposta è il collo di bottiglia più grosso a monte.
3. **`document.number` e `document.issue_date`** — vincolare la selezione al contesto (etichetta vicina, posizione in testata) invece di prendere il primo match. Due terzi degli errori di valore.
4. **Normalizzare le date all'inserimento** — senza questo non si può misurare nulla sulle date.
5. **`origin` sui campi `many`** (fatto), e non far perdere la selezione a chi ripulisce un OCR letto male: sulle scansioni si registra il 41% delle selezioni contro l'89% dei PDF con testo nativo. Le tre correzioni che servono sono nel poscritto qui sopra.
6. **Stop-list sui pattern CLASS** per i token che coincidono con entità del documento (fatto).
7. **Ripassare le revisioni già chiuse** perché il learner veda anche quelle di prima che fosse acceso (fatto, dopo il punto 1).

---

## Stato dei sei punti

| # | Problema | Esito |
|---|---|---|
| 1 | Impronta del modulo, una per documento | ✅ PR #24 |
| 2 | Classificatore senza proposta su 27 documenti su 41 | ⚠️ PR #25 — l'export adesso dice *perché*; la taratura aspetta un export nuovo |
| 3 | `document.number` e `document.issue_date` letti dentro citazioni | ⚠️ PR #26 — 16 dei 18 casi coperti; due senza contesto restano |
| 4 | Il learner non ha visto le revisioni di prima | ✅ PR #30 |
| 5 | `origin` mancante sui campi ripetuti | ✅ PR #28 (e §5 corretto) |
| 5b | Date del revisore non normalizzate | ✅ PR #27 |
| 6 | Ancore CLASS costruite su nomi propri | ✅ PR #29 |

## Risolto: la selezione presa con l'OCR

Segnalato dal revisore il 18/09 e verificato sul codice e sull'export (poscritto qui sopra). Non era il flusso di revisione: erano tre difetti distinti, in fila sullo stesso gesto, corretti in tre PR nell'ordine in cui erano stati messi.

| # | Problema | Dove | Esito |
|---|---|---|---|
| A | L'area disegnata su una pagina che ha il testo viene comunque ri-letta a OCR: 7 selezioni su 50 perdono ogni posizione, 13 su 50 perdono gli offset | `pdf-viewer.tsx:211` | ✅ PR #32 |
| B | Ripulire una parola letta male cancella la selezione: il valore corretto non coincide più col testo selezionato | `field-edits.ts:54`, `evidence.ts:100`, `field-editor.tsx:71` | ✅ PR #33 |
| C | Le righe di una pagina letta a OCR non hanno coordinate: 10 selezioni su 11 restano senza posizione e nessuna regola nasce da una scansione | `extract/text.ts:84`, `ocr-worker.ts` | ✅ PR #34 |

L'ordine era questo, ed è stato rispettato: **(1)** l'area legge il text layer, che toglie la maggior parte delle occasioni di sbagliare; **(2)** ripulire un OCR non cancella più la selezione, che salva quelle che restano; **(3)** l'OCR restituisce le coordinate delle righe, che riapre l'apprendimento sulle scansioni.

### ✅ Risolto — PR #32, `bugfix/area-pick-reads-text-layer`

L'area evidenziata su una pagina che il testo ce l'ha si legge adesso **dal text layer**, e l'OCR resta dov'è l'unico modo di leggere: le scansioni. Il gesto del revisore non cambia — è lo stesso riquadro, ed è il più rapido — cambia da dove arriva il testo.

Il riquadro non si ferma ai bordi di uno span, e uno span di pdf.js può essere una riga intera: `FATTURA n. 114/2026 del 08/09/2026` è un solo span, e prenderlo tutto porterebbe nel campo la riga al posto del numero. Quindi si decide **carattere per carattere** (`src/renderer/src/lib/area-text.ts`), misurandoli con un `Range`: dentro c'è chi ha il centro dentro il riquadro. Un carattere a metà sul bordo sta di là — mezzo carattere non è un carattere — e le righe si ricostruiscono dal salto verticale fra un carattere e il precedente. Gli span che il riquadro non tocca si scartano prima di misurarli: un `getBoundingClientRect` per ogni carattere della pagina costerebbe troppo per un gesto del mouse.

Il modo si chiama `AREA_TEXT`, accanto a `TEXT_SELECTION` e `AREA_OCR`: stesso gesto dell'area, testo esatto invece di una rilettura dei pixel. Tenerlo distinto serve a misurare, la prossima volta, quante selezioni ad area sono passate dal text layer. Il formato del dataset va a **1.6.0** — un valore in più a `pick.method`, nient'altro.

È il punto che vale per le 50 selezioni ad area fatte su pagine col testo — quelle che oggi perdono ogni posizione (7) o i soli offset (13). Il testo che arriva al main è adesso quello delle righe che l'elaborazione ha salvato, perché le une e le altre vengono dallo stesso text content di pdf.js: `locatePick` le ritrova, tranne dove il valore compare più volte e il riquadro non basta a distinguerlo — lì restano le righe senza offset, come è giusto. E non c'è più un OCR da ripulire, quindi su queste pagine non si passa nemmeno dal punto B.

**Quello che resta aperto:** niente di questo punto, ma vale solo da qui in avanti. Le selezioni già registrate come `AREA_OCR` restano quelle che sono; per rivedere i numeri serve un export nuovo.

Verifiche: gate completo verde (712 test); 6 test in `tests/renderer/area-text.test.ts` (il numero dentro lo span di riga, il carattere sul bordo, l'area su due righe, gli spazi ai bordi, il riquadro vuoto), fixture `dataset-export.expected.json` rigenerata, README aggiornato. Non provato nell'app: serve aprire un PDF e disegnare un'area per vedere il testo arrivare nel campo.

### ✅ Risolto — PR #33, `bugfix/ocr-cleanup-keeps-the-pick`

I tre punti del §A vanno toccati insieme, ed è quello che questa PR fa: il campo rimanda indietro la selezione che il valore aveva già (`pickOfEvidence`, dalla scheda di revisione), e il main la tiene invece di rifiutarla perché il testo non coincide più. `pruneReviewer` non ha più niente da cancellare, perché la correzione continua a citarla.

**L'eccezione è stretta, e dichiarata.** Vale solo per un'area passata dall'OCR — lì il testo l'ha letto una macchina, e chi sistema la parola non sta cambiando valore — e solo se il valore è quella lettura sistemata: oltre **un quarto** di caratteri cambiati non è più la stessa lettura, è un altro valore (`src/shared/pick-cleanup.ts`, distanza di edit su testo ripiegato). Il testo di una selezione, e quello di un'area letta dal text layer (PR #32), vengono dal documento: lì il controllo carattere per carattere resta tale e quale, ed è giusto che resti — `114/2026` corretto in `114/2026-bis` è un valore diverso, non una lettura sistemata.

Quello che si salva è **l'etichetta**: l'evidenza porta adesso `textCorrected` (migrazione `0015`), il suo `text` resta verbatim la lettura dell'OCR — è quello che c'è su quel punto del documento — e il valore buono sta sul campo. La posizione si cerca prima col testo letto e, se da lì non escono gli offset, col valore sistemato: senza `charStart` `deriveAnchor` non risale a niente, e i due tentativi non indovinano nulla, perché `locatePick` chiede un riscontro esatto. In revisione l'evidenza lo dice: «· lettura sistemata». Il formato del dataset va a **1.7.0**.

**Quello che resta aperto:** sulle scansioni gli offset spesso non ci saranno comunque, perché le righe della pagina non hanno coordinate e il testo del ritaglio non coincide con quello della pagina. È il punto C, e questa correzione da sola non lo copre: senza il C la selezione si conserva, ma resta muta per il learner.

Verifiche: gate completo verde (725 test); `tests/shared-pick-cleanup.test.ts` (9 test, valori verbatim dall'export: `29 O7 2026`, `FRAITA (MAB)`) e 3 test nuovi in `tests/field-edits.test.ts` — la lettura sistemata che tiene la selezione, il valore diverso che la perde lo stesso, il testo selezionato che non ha eccezioni — più il test della 0015, fixture rigenerata, README aggiornato. Non provato nell'app: serve una scansione, un'area letta male e una parola sistemata a mano.

### ✅ Risolto — PR #34, `bugfix/ocr-returns-word-boxes`

Le righe di una pagina letta con l'OCR hanno adesso le **coordinate**. `tesseract.js` le restituisce già — il motore chiedeva solo il testo e buttava via la struttura — in pixel dell'immagine; la matrice con cui la pagina disegna quell'immagine le porta nelle stesse unità di pagina delle righe del text layer.

La matrice si ricostruisce seguendo la lista degli operatori di pdf.js: `save`/`restore` sono la pila, `transform` la moltiplica, un form XObject apre una parentesi con la sua, e quando l'immagine viene disegnata la matrice corrente è quella che manda il quadrato unitario dove la pagina la mostra (`src/main/extract/page-placement.ts`). Si mappano tutti e quattro gli angoli, non due: una scansione girata ha gli assi scambiati, e due soli angoli darebbero un rettangolo al contrario. Dove la matrice non si ricostruisce la riga resta senza riquadro, com'era prima: **nessuna posizione è meglio di una indovinata**.

Con le righe dotate di riquadro `locatePick` torna a lavorare per sovrapposizione anche sulle scansioni: il riquadro disegnato tocca delle righe, e quelle righe sono una posizione — anche quando il testo del ritaglio e quello della pagina non coincidono, che è la norma, perché sono due letture diverse della stessa area. È quello che toglieva la posizione a 10 selezioni su 11 delle scansioni dell'export.

**Quello che resta aperto:** gli offset dentro la riga restano legati a un riscontro esatto del testo, quindi su una scansione di solito non ci saranno, e `deriveAnchor` senza offset non impara. Il riquadro da solo dà la riga, non la colonna. Il passo dopo — se servirà — è confrontare le parole del ritaglio con quelle della riga, che le coordinate adesso permettono. E vale da qui in avanti: le scansioni già a database prendono le coordinate alla prossima rielaborazione.

Verifiche: gate completo verde (734 test); `tests/extract-page-placement.test.ts` (7 test sulla matrice: pagina intera, mezza pagina, scansione girata, riquadro schiacciato, composizione) e `tests/extract-ocr-lines.test.ts` (2 test sull'OCR vero di `durc-scansionato.pdf`: ogni riga dentro la pagina e nell'ordine giusto, e una selezione ad area che si ritrova per sovrapposizione con un testo che non c'entra). Non provato nell'app: serve rielaborare una scansione e disegnarci sopra un'area.
