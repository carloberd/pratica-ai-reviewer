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

**I campi `many` non hanno mai `origin` né `evidence`.** Tutti e 19 (`line_items`, `finance.transactions`, `hse.preventive_measures`), compresi i 7 popolati. Sono 34 correzioni, il 12% del totale, non attribuibili a motore o revisore — un buco nella misurazione, oltre che un probabile bug dell'export.

**Le `line_items` sono estratte come righe di testo grezze**, non strutturate:

```
"3 |LGICSL60001674 PZ 5x5000 MQ 26,6250 9,100 9,100 242,29 |22 LASTRA GRECATA..."
```

**Evidenza mancante su 271 campi su 360.** Tutti i campi ENGINE ce l'hanno, ma solo 31 dei 229 REVIEWER: quando il valore lo scrive la persona, page e bbox in genere non vengono registrati. Sono proprio i casi da cui il learner dovrebbe imparare le ancore.

**65 slot core/optional restano vuoti** dopo la review (46 di ruolo `core`), e 5 documenti sono stati chiusi senza tipo, due dei quali con i campi comunque compilati.

## Dove intervenire, in ordine

1. **Fingerprint del template** — normalizzare prima di hashare. Senza questo l'intero ramo TEMPLATE del learner è codice morto.
2. **Copertura del classificatore** — 27 documenti su 41 senza proposta è il collo di bottiglia più grosso a monte.
3. **`document.number` e `document.issue_date`** — vincolare la selezione al contesto (etichetta vicina, posizione in testata) invece di prendere il primo match. Due terzi degli errori di valore.
4. **Normalizzare le date all'inserimento** — senza questo non si può misurare nulla sulle date.
5. **`origin`/`evidence` sui campi `many`** e registrazione dell'evidenza sui valori del revisore.
6. **Stop-list sui pattern CLASS** per i token che coincidono con entità del documento.
