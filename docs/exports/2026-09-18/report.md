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

## 4. Il learner ha visto un ottavo dei dati

I 122 eventi coprono **11 documenti distinti**, tutti in una sola sessione di oggi (07:49–09:02), un solo attore. Il dataset ha 281 correzioni su 41 documenti: il learner ne ha osservate 122, e le correzioni fatte prima che il logging fosse attivo sono perse per l'apprendimento.

Se le revisioni storiche sono ricostruibili dal dataset, un replay one-shot degli eventi porterebbe subito il support a livelli utili — ma solo dopo aver sistemato il fingerprint, altrimenti si moltiplicano regole a support 1.

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

Il taglio per tipo di correzione dice di più: dei 31 `CHANGED`, **solo 3 hanno un `pick`**; degli 11 `CLEARED`, nessuno — ma lì è giusto, svuotare non ha una sorgente. Quando il revisore *corregge* un valore del motore, quasi sempre riscrive invece di selezionare, e da una riscrittura il learner non ricava nessuna ancora: gli serve la posizione della selezione per risalire all'etichetta.

Dei 75 `pick` registrati, 61 sono `AREA_OCR` e 14 `TEXT_SELECTION`, e 58 su 75 hanno una `location` utilizzabile. Il meccanismo funziona: è che si usa in un caso su quattro.

Questo non è un bug da correggere in un modulo — è il flusso di revisione. Selezionare costa più che digitare, e finché costa di più il learner resterà a digiuno sui `CHANGED`, che sono proprio i casi da cui imparerebbe di più. Va affrontato in revisione, non nell'export.

**65 slot core/optional restano vuoti** dopo la review (46 di ruolo `core`), e 5 documenti sono stati chiusi senza tipo, due dei quali con i campi comunque compilati.

## Dove intervenire, in ordine

1. **Fingerprint del template** — normalizzare prima di hashare. Senza questo l'intero ramo TEMPLATE del learner è codice morto.
2. **Copertura del classificatore** — 27 documenti su 41 senza proposta è il collo di bottiglia più grosso a monte.
3. **`document.number` e `document.issue_date`** — vincolare la selezione al contesto (etichetta vicina, posizione in testata) invece di prendere il primo match. Due terzi degli errori di valore.
4. **Normalizzare le date all'inserimento** — senza questo non si può misurare nulla sulle date.
5. **`origin` sui campi `many`** (fatto), e far sì che correggere un valore passi più spesso dalla selezione sul documento: oggi solo 3 `CHANGED` su 31 lasciano una traccia da cui imparare.
6. **Stop-list sui pattern CLASS** per i token che coincidono con entità del documento.
