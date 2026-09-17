# Apprendimento locale dalle selezioni del revisore — analisi

Obiettivo: fare in modo che il reviewer impari da come il revisore seleziona i dati nei
PDF, così che i documenti successivi arrivino precompilati meglio.

Punto di partenza: il pacchetto di handoff *PraticaAI Reviewer v1.5 — Local Continual
Learning* (in `external/`, fuori da git), scritto sulla v1.4.1 (`b05028b`). Da quel commit
`main` ha cambiato solo la navigazione delle cartelle di Drive, quindi i punti di aggancio
che il pacchetto indica valgono ancora.

---

## Cos'è il pacchetto

Non è un progetto funzionante: otto documenti di specifica e circa 500 righe di codice di
riferimento. Il `MANIFEST.json` lo dichiara (`implementation_completed: false`,
`files_under_proposed_are_reference_code: true`).

| File | Contenuto |
|---|---|
| `01_SPEC_FUNZIONALE.md` | Modalità `LEARNING`/`FROZEN`, feedback su tipo e campi, stati delle regole, template memory, UI minima, audit |
| `02_ARCHITETTURA.md` | Learner deterministico sopra il motore v2, registry immutabile + overlay nel DB |
| `03_INTEGRAZIONE_V1.4.1.md` | Punti di aggancio: `review.ts`, `pipeline.ts`, `classify-v2.ts`, `profile-refinement.ts`, `config.ts` |
| `04_CRITERI_ACCETTAZIONE.md`, `05_TEST_PLAN.md` | Scenari e test |
| `06_SECURITY_HOLDOUT.md` | Niente apprendimento da input non confermato, PII, contaminazione del benchmark, drift |
| `07_PATCH_GUIDE.md` | Sequenza in cinque PR e cosa non fare nella prima iterazione |
| `proposed/` | Migration `0010`, tipi condivisi, DAO, learner, overlay del classificatore, memoria di estrazione, policy di promozione |

### Le idee che reggono

- **Registry immutabile, apprendimento nel DB.** I JSON di `resources/registry/v2` non si
  toccano; quello che si impara sta in tabelle locali e si somma alla base in lettura. È lo
  stesso schema già adottato da `profile-map` con la migration `0008`.
- **Si impara alla chiusura della review**, non a ogni modifica di un campo: la review è
  la decisione finale, le modifiche intermedie no.
- **Regole con un ciclo di vita**: `CANDIDATE → ACTIVE → SUSPENDED → REJECTED`, promosse o
  sospese in base a supporto (quante review le confermano) e precisione (quante volte ci
  hanno preso). Soglie iniziali: template 2 con precisione 1,0; tipo 3 con precisione ≥ 0,90.
- **Cronologia append-only con revert**: annullare è una nuova azione, non una cancellazione.
- **Rielaborazione solo dei documenti `NEEDS_REVIEW`**, in coda seriale, ricontrollando lo
  stato al momento del job: è quello che fa già `reprocessQueueOfType` in
  `src/main/profile-refinement.ts`.
- **Due modalità**: `LEARNING` acquisisce e applica; `FROZEN` non modifica nulla, per
  holdout e benchmark.
- **Provenienza**: ogni valore proposto da una regola appresa deve dire quale regola, e
  `extraction_runs.metrics_json` deve registrare modalità e regole applicate.

---

## Cosa si riprende del codice proposto

| File | Stato | Giudizio |
|---|---|---|
| Specifiche, criteri di accettazione, piano test | Completi | Si riprendono come riferimento |
| `local-learning/classifier-overlay.ts` | Funziona | Si riprende quasi com'è: somma le frasi apprese a `ClassifierConfigV2` senza cambiare `matchDocumentTypeV2` |
| `local-learning/promotion-policy.ts` | Abbozzato | Da sistemare: una regola `SUSPENDED` che rientra nelle soglie torna `ACTIVE` da sola, quindi una sospensione manuale non tiene; gli «errori consecutivi» della specifica non sono modellati |
| `db/migrations/0010_local_learning.sql` | Abbozzato | Da adattare: `source_release` fisso a `'v1.4.1'`; `CURRENT_TIMESTAMP` scrive un formato diverso dalle date ISO del resto del DB; il `ON DELETE CASCADE` sui documenti cancella le prove a sostegno delle regole |
| `db/dao/local-learning.ts` | Abbozzato | Da riscrivere: mapping con `as any`, non passa Biome |
| `local-learning/learner.ts` | Solo registrazione | Registra gli eventi ma non ricava regole (TODO); su `APPROVE` mette nel payload tutti i valori dei campi, cioè dati personali |
| `local-learning/extraction-memory.ts` | Vuoto | La parte che serve all'obiettivo non è implementata |

---

## Il buco rispetto all'obiettivo

Il pacchetto impara confrontando il valore prima e dopo la correzione. Il segnale utile
però è **dove** il revisore ha preso il valore, e oggi l'app lo scarta:

- `src/renderer/src/components/review-view.tsx:117` — `capture(text)` salva solo il testo:
  niente pagina, riquadro, riga o etichetta vicina.
- `src/renderer/src/components/pdf-viewer.tsx` — l'area letta con OCR ha il suo riquadro in
  coordinate di pagina, ma non arriva al main.
- `fields.corrected_value` e `field_items.corrected_value_json` non hanno un'evidenza
  collegata.

Senza la posizione il learner dovrebbe ritrovare il valore nel testo per indovinarne
l'etichetta, e con date e importi che compaiono più volte sbaglia.

### Cosa invece combacia

- **Il motore di estrazione** (`src/main/extract/v2/fact-reader.ts`) cerca un'etichetta e
  legge il valore sulla stessa riga o su quella successiva. Una regola appresa ha quindi già
  una forma naturale: *campo, etichetta, stessa riga / riga successiva, ambito*.
- **«Aggiungi etichetta»** (`ADD_HINT_LABEL`, `src/main/profile-map.ts`) fa già questo, ma
  a mano e valido per il campo in tutti i tipi. Il learner lo automatizza e lo restringe a
  tipo o template.
- **`classification_json`** conserva candidati e segnali del classificatore, quindi quello
  che il motore aveva proposto prima di un cambio di tipo.
- **L'impronta del template** (`src/shared/template-fingerprint.ts`) esiste, ma oggi si
  calcola solo nell'export XLSX (`src/main/xlsx-export.ts:67`): va calcolata durante
  l'elaborazione.
- **Le righe con coordinate** su cui ricavare l'etichetta non sono salvate da nessuna
  parte: la tabella FTS ha il testo della pagina senza coordinate.
- **Priorità delle etichette**: in `fact-reader.ts` vince sempre l'etichetta più lunga
  (`compareCandidates`). Per far valere prima una regola di template serve un livello di
  priorità in più.

---

## Piano d'azione proposto

Ripreso da `07_PATCH_GUIDE.md`, riordinato attorno all'estrazione.

### PR 1 — Salvare da dove viene il valore selezionato
- Il renderer manda, insieme al valore, pagina, riquadro e origine (`TEXT`, `AREA_OCR`,
  `TYPED`). Per la selezione di testo il riquadro è l'unione dei rettangoli della selezione
  divisa per la scala.
- Nel main il valore scelto a mano ottiene un'evidenza propria collegata al campo o alla riga.
- Durante l'elaborazione si salvano l'impronta del template e le righe con coordinate.
- Utile anche senza learner: evidenziazione nel PDF dei valori scelti a mano e posizione
  nell'export del dataset.

### PR 2 — Tabelle del learner e modalità
- Migration adattata dalla `0010` del pacchetto; DAO tipizzato.
- Modalità salvata nel DB, cambio registrato in cronologia.
- Test: in `FROZEN` nessuna scrittura del learner.

### PR 3 — Registrazione alla chiusura della review
- L'IPC costruisce il payload e lo passa a `submitReview` (opzione C di
  `proposed/HOOK_REVIEW_SUBMIT.md`); il learner parte dopo la transazione.
- Eventi: valore scelto con posizione, correzione, svuotamento, conferma, cambio di tipo.
- Nelle tabelle del learner niente valori: solo etichetta e relazione.

### PR 4 — Regole di estrazione
- Dalla posizione si ricavano riga ed etichetta (testo prima del valore sulla stessa riga,
  oppure riga sopra), con filtri su lunghezza e forma (niente PII, niente testo quasi solo
  cifre).
- Ogni scelta aggiorna una regola di template e una di tipo; promozione con le soglie sopra.
- In `fact-reader.ts` le etichette apprese entrano con priorità template → tipo → registry;
  i validatori restano l'ultima parola.
- Valore proposto da una regola e poi corretto: evidenza negativa; approvato: positiva.
- Cambio di stato di una regola: rielaborazione della coda del tipo; regole applicate in
  `extraction_runs.metrics_json`.

### PR 5 — Classificazione
- Prima la memoria template → tipo: bonus limitato quando un template ha N review tutte
  dello stesso tipo e nessun conflitto.
- Poi le frasi apprese per il classificatore (`mergeClassifierConfig`), la parte più
  rischiosa per PII e falsi segnali.

### PR 6 — Interfaccia
- Badge della modalità con interruttore, contatori.
- «Regole apprese» in Cronologia con sospendi e annulla.
- Accanto al campo, la regola che ha proposto il valore.

### Da non fare nella prima iterazione
Come da pacchetto: niente fine-tuning, embedding o vector DB; niente promozione globale da
un solo esempio; niente scritture sui JSON del registry; niente apprendimento durante un
holdout.

---

## Compatibilità con pratica-ai

Il reviewer un giorno finirà dentro pratica-ai (`~/dev/personal/pratica-ai`). Verificato
su `76c0853`, le scelte sopra vanno lette contro come quel progetto legge i documenti.

### Due sistemi diversi sotto lo stesso vocabolario

| | Reviewer | pratica-ai |
|---|---|---|
| Esecuzione | Desktop, un utente, SQLite | NestJS multi-tenant, Postgres |
| Testo | pdf.js (righe con coordinate) + tesseract | markitdown via `brainer-document-converter`: **markdown, niente pagine né coordinate**. Il repo «non ha una libreria PDF e non deve averne una» (`document-converter.service.ts`) |
| Classificazione | Classificatore v2 deterministico (`classifier_signals_v2.json`, segnali per 11 classi) | Ensemble: voto sul titolo + voto lessicale su V5.1, poi un voto LLM (`classifier-ensemble.util.ts`) |
| Estrazione | `fact-reader.ts`: etichetta → valore, regole fisse | LLM per chunk, citazione verbatim verificata (`verifyCitation`), fatti per ruolo in `document_facts`, colonna `field` aggiunta da poco |
| Campi | Ontologia v2, 248 id puntati (`document.issue_date`) | 40 campi snake_case di V5.1 (`issue_date`) |
| Tipi | Profili v2: 495 id su 500 in comune con V5.1 | 511 record V5.1 + estensioni proprie |
| Feedback umano | Correzioni sui campi, nessun registro di apprendimento | `document_type_feedback` (append-only) e `fact_versions.verificationState` (`AI_EXTRACTED` / `HUMAN_VERIFIED` / `REJECTED`) |

### Cosa è già allineato

- **Registry immutabile + estensioni sopra.** `packages/document-registry` copia i JSON
  byte per byte, li verifica con gli hash e somma `praticaai_extensions.json` in lettura:
  è la stessa regola del learner.
- **Un registro di feedback esiste già, ed è il modello da seguire.**
  `document_type_feedback` è append-only, **senza foreign key** (il documento può sparire,
  la prova no), indicizzato sull'**hash dei byte** e non sull'id del documento, con autore
  obbligatorio, e conserva anche le conferme (`accepted: true`) come esempi positivi. La
  forma è quella di `feedback_event.schema.json` di V5.1 (`prediction`, `correction`,
  `field_corrections`, `evidence_refs`, `privacy_class`).
- **Evidenza verbatim.** `evidence_envelope.schema.json` di V5.1 descrive un campo estratto
  con `literal_evidence`, `evidence_start`/`evidence_end` (offset nel testo) e
  `source: DETERMINISTIC | PROVIDER_VERIFIED`: il contratto prevede già un estrattore
  deterministico accanto al modello.
- **Disciplina dell'holdout.** L'eval di pratica-ai ha un holdout cieco (G2, 81 documenti
  presi da Drive), predizioni congelate prima delle etichette (`eval run --freeze`) e
  controllo dei duplicati fra le parti (`splits.ts`). È la semantica FROZEN-A.
- **Prudenza sulle azioni automatiche.** Sotto `VALIDATED` nessuna classe autorizza azioni
  automatiche, e `CLOSURE_CALIBRATION.measured` resta `false` finché non è misurata. Una
  regola appresa, anche `ACTIVE`, lì può solo precompilare per una persona.
- **Il problema da risolvere è lo stesso.** `docs/prod-field-coverage.md`: `issue_date` è
  valorizzato con un'etichetta esplicita solo nel 20% dei documenti del registry, e
  l'etichetta più frequente di una data è «data» da sola. Imparare *quale etichetta indica
  quale campo per quel tipo* è proprio ciò che serve anche lì.

### Cosa non si trasferisce, e come evitarlo

1. **Coordinate.** pratica-ai non ha riquadri. Una regola espressa in coordinate non serve
   lì. → Regola espressa **in termini di testo**: etichetta, relazione, lettore semantico.
   L'evento conserva anche il testo letterale e gli offset nella pagina, come l'evidence
   envelope; pagina e riquadro servono al reviewer, non sono la regola.
2. **Righe diverse.** markitdown trasforma le tabelle in righe `| Etichetta | Valore |`.
   «Stessa riga» regge (etichetta e valore in celle vicine), «riga successiva» in una
   tabella vuol dire «stessa colonna, riga sotto». → Vocabolario delle relazioni neutro
   rispetto all'estrattore, con la conversione per la tabella markdown lasciata a
   pratica-ai.
3. **Impronta del template.** Si calcola sulle righe pdf.js della prima pagina: lo stesso
   documento in markdown dà un'altra impronta. → Le regole di **template** restano locali
   all'estrattore che le ha prodotte e portano la versione dell'algoritmo. Le regole di
   **tipo** e gli eventi grezzi (con l'hash dei byte) sono la parte portabile: pratica-ai
   può ricalcolare la sua impronta dai byte.
4. **Hash dei documenti.** Il reviewer oggi identifica i documenti per id Drive e uuid, e
   non calcola nessun hash del contenuto. → Calcolare lo sha-256 del file in cache durante
   l'elaborazione e metterlo su ogni evento: è la chiave su cui i due dataset si uniscono.
5. **Id dei campi.** Ontologia v2 puntata contro i 40 campi V5.1. `legacy_field_map_v2.json`
   copre i 40; gli altri ~208 campi v2 non hanno corrispondenza. → Gli eventi portano l'id
   v2; l'export verso pratica-ai traduce con la mappa e segnala ciò che non ha equivalente.
6. **Id dei tipi.** 495 su 500 coincidono. I 5 restanti sono classi che pratica-ai ha
   aggiunto con slug diversi (per esempio `hse_risk.autocertificazione_idoneita_tecnico_professionale`
   contro `hse_risk.idoneita_autocertificazione`, `payroll_contributions.dichiarazione_regolarita_retributiva`
   contro `payroll_contributions.regolarita_retributiva`). → Da riallineare prima di
   un'integrazione, indipendentemente dal learner.
7. **Frasi del classificatore.** `mergeClassifierConfig` dipende dalla forma di
   `ClassifierConfigV2`, che pratica-ai non usa (V5.1 ha `positive_signals`,
   `strong_signals`, `negative_signals` e regole di disambiguazione). → Portabile è il
   dato (frase, tipo, polarità, supporto), non il codice di fusione.
8. **Multi-tenant e PII.** Le etichette apprese su un'azienda possono contenere nomi di
   fornitori. → Nessun valore nelle tabelle del learner, filtro PII sulle etichette, un
   campo `privacy_class` come in `feedback_event.schema.json`. In pratica-ai le regole
   saranno per tenant; la promozione a regola globale è una decisione di quel progetto.
9. **Logica pura.** pratica-ai tiene aritmetica e decisione del classificatore in funzioni
   pure parametriche nelle soglie (`classifier-ensemble.util.ts`), così l'eval e il
   servizio eseguono lo stesso codice. → Derivazione delle etichette, aggiornamento dei
   contatori e policy di promozione in moduli senza database né Electron (`src/shared/`),
   pronti per diventare `common/utils/*.util.ts`.

### Come entrerebbe il learner in pratica-ai

Il punto d'ingresso naturale è uno **stadio deterministico prima del modello**, come per il
classificatore: le regole attive leggono i chunk markdown, i candidati passano da
`verifyCitation` ed escono come evidence envelope con `source: DETERMINISTIC`; il modello
resta il secondo lettore. Il feedback nasce dove oggi un fatto diventa `HUMAN_VERIFIED` o
`REJECTED` e dove un tipo viene corretto (`VaultService.setDocumentType`), accanto alla
scrittura su `document_type_feedback`.

### Modifiche al piano che ne derivano

- **PR 1**: oltre a pagina e riquadro, testo letterale e offset nella pagina; sha-256 del
  file calcolato durante l'elaborazione.
- **PR 2**: eventi nella forma di `feedback_event.schema.json`, chiave sull'hash, nessun
  `ON DELETE CASCADE` verso `documents`, autore sull'evento.
- **PR 4**: regole in termini di testo; logica in `src/shared/` senza dipendenze; regole di
  template marcate con la versione dell'algoritmo d'impronta.
- **PR 5**: il merge nel classificatore resta codice del reviewer; il dato appreso si
  esporta in forma neutra.
- **Export** (PR 6): bundle delle regole di tipo e degli eventi, con i campi tradotti in
  V5.1 e senza valori.

---

## Decisioni prese (17/09/2026)

1. **Tre modalità, non due.**
   - `LEARNING`: registra gli eventi, aggiorna le regole, applica quelle attive.
   - `FROZEN` (FROZEN-B): applica le regole già attive, non registra e non cambia nulla.
     Per l'uso quotidiano quando non si vuole insegnare.
   - `BASELINE` (FROZEN-A): solo registry, nessuna regola applicata né scritta. Per i
     benchmark e per annotare documenti di un holdout, coerente con l'eval di pratica-ai.

   Conseguenze: la modalità e, in `FROZEN`, l'istantanea delle regole applicate finiscono in
   `extraction_runs.metrics_json`; ogni cambio di modalità è un'azione in cronologia; il
   cambio di modalità non rielabora da solo i documenti già revisionati. Nomi confermati
   (17/09/2026).
2. **Estrazione prima** (PR 1–4), classificazione dopo.
3. **Righe salvate durante l'elaborazione.** Il learner ritrova la riga dalla posizione della
   selezione sulle stesse righe usate dal `fact-reader`, OCR compreso. La regola resta
   espressa in testo (etichetta, relazione, lettore), non in coordinate.

---

## Avanzamento

### PR 1 — fatta (#11)

Selezione con pagina, riquadro e modo; evidenza `REVIEWER` collegata alla correzione;
righe per pagina in `document_pages` e posizione della selezione fra quelle righe; sha-256
del file e impronta calcolati in elaborazione; dataset JSON `1.1.0`. Da verificare
nell'app: il riquadro calcolato da una selezione reale nel text layer di pdf.js.

### PR 2 — deposito e modalità

Migrazione `0011_learning_store`, tipi in `src/shared/local-learning.ts`, DAO in
`src/main/db/dao/learning.ts`. Scelte rispetto alla migrazione proposta dal pacchetto:

- **Modalità su una riga sola** (`learning_state`, `id = 1`) con CHECK sulle tre modalità,
  invece di una tabella chiave/valore. La versione del learner è una costante del codice
  (`LEARNER_VERSION`), scritta su eventi e regole: descrive la logica, non lo stato.
- **Eventi senza valori né testo**: decisione (`kind` + `outcome`, lo stesso vocabolario
  delle correzioni del dataset più `CONFIRMED`), tipo proposto e scelto, campo, riga,
  confidence del motore, posizione della selezione, autore, sha-256, impronta. Nessuna
  foreign key verso `documents`: il registro sopravvive al documento.
- **Supporto e precisione non salvati**: si ricavano da `positive_count` e
  `negative_count`, che una prova incrementa una volta sola per coppia regola-evento.
- **`rule_key` univoca**: la stessa regola imparata due volte è una riga sola.
- **Cronologia solo per i cambi di stato** (promozione, sospensione, riattivazione,
  scarto) e di modalità: le candidate nascono senza riga, o ogni revisione ne scriverebbe
  decine. I passaggi ammessi sono fissati nel DAO; una regola scartata non torna.
- **Scritture solo dentro `acquire`**, in transazione e solo in `LEARNING`: la garanzia su
  `FROZEN` e `BASELINE` è strutturale, e il test lo verifica eseguendo lo stesso lavoro
  nelle tre modalità.

Non c'è ancora un canale IPC né UI per la modalità: arrivano con la PR 6.

### PR 3 — registrazione alla chiusura della review

`src/shared/review-learning.ts` trasforma il documento salvato in eventi (funzione pura,
riusabile in pratica-ai); `src/main/review-learning.ts` li scrive con `learning.acquire`
dentro la transazione di `submitReview`. Scelte:

- **Niente opzione C** di `proposed/HOOK_REVIEW_SUBMIT.md` (payload costruito dall'IPC): la
  chiusura non tocca i campi, quindi il documento letto prima della transazione è già lo
  stato finale, e `submitReview` lo passa al learner senza duplicare logica.
- **Stessa transazione** della revisione, come `document_type_feedback` in pratica-ai:
  una revisione senza eventi perde il dato che non si ricostruisce, eventi senza revisione
  insegnano qualcosa che non è successo.
- **Solo `SAVE`**: uno scarto è fuori dal dataset e da quello che il motore impara.
- **Autore obbligatorio**: l'email dell'account collegato; senza, non si registra e la
  timeline lo dice.
- **Eventi**: tipo `CONFIRMED`/`CHANGED`/`FILLED`/`CLEARED` (niente evento se la proposta
  non è nota: tipo messo a mano senza classificazione salvata); campi e righe con gli esiti
  delle correzioni più `CONFIRMED` per le proposte tenute; nessun evento per un campo vuoto
  non toccato. La selezione va sull'evento del valore che il revisore ha messo.

Da tenere presente nella PR 4:

- **Richiudere un documento registra di nuovo** gli stessi eventi. Il registro non si
  riscrive, quindi è la derivazione delle regole che deve contare una prova per documento
  (per `content_sha256`), non per evento, o un documento salvato due volte vale doppio.
- **Un documento salvato e poi scartato** ha già i suoi eventi: la derivazione deve
  considerare solo l'ultima chiusura di ogni documento.
- **Campi del motore v1** arrivano coi nomi legacy (`issue_date`): vanno tradotti con
  `legacy_field_map_v2.json` o ignorati.

### PR 4 — regole di estrazione

Migrazione `0012_learning_provenance`; derivazione in `src/main/learning-anchors.ts`,
apprendimento in `src/main/review-learning.ts`, applicazione in `fact-reader.ts` e
`pipeline.ts`. Scelte:

- **Etichetta verificata con il motore.** `readsOfLabel` è la lettura dell'estrazione resa
  pubblica (e usata dall'estrazione stessa): un'etichetta candidata vale solo se su quella
  pagina legge un valore in un punto solo, e quel punto è la selezione. Vince la più corta.
  Niente cifre, al massimo tre parole, stop a un'altra etichetta: è anche il filtro PII più
  semplice, perché nomi e codici stanno quasi sempre dopo i due punti, non prima.
- **Due regole per selezione**, template e tipo, con chiave stabile (`anchorRuleKey`).
- **Livelli nell'estrazione**: template > tipo > registry, poi lunghezza dell'etichetta.
  Una regola appresa legge solo nella sua relazione (stessa riga o riga successiva).
- **Una prova per documento**, per sha-256 (tabella delle prove ricreata con
  `document_key`): richiudere sostituisce, scartare ritira, e sullo stesso documento la
  smentita prevale. Risolve i due punti lasciati dalla PR 3.
- **Prova alla regola che ha proposto il valore** (`evidence.rule_id` →
  `learning_events.engine_rule_id`): conferma a favore, correzione contro, salvo quando la
  selezione insegna la stessa regola (correzione di sola forma, come «07/11/2026» contro
  «2026-11-07»).
- **Policy**: come la specifica, con due differenze. La precisione sospende solo da 5 prove
  in su, perché dopo 2 conferme una smentita fa già il 67% e la regola non è sbagliata;
  prima decidono le 2 smentite di fila. E il learner non riattiva una regola sospesa: una
  sospensione a mano (PR 6) non deve durare fino alla prossima conferma.
- **Campi v1** ignorati per la derivazione: non sono nell'ontologia v2, quindi non hanno un
  lettore. Il terzo punto lasciato dalla PR 3.
- **Rielaborazione** della coda del tipo quando una regola si attiva o si sospende, con
  `reprocessQueueOfType` dopo la chiusura della transazione.

Definizione di «fatto» del pacchetto, in `tests/learning-flow.test.ts` sui promemoria della
stessa serie (fixture nuove, generate con date fisse):

- due selezioni attivano la regola di template, e il documento in coda arriva con la data
  compilata, la regola nell'evidenza e nelle metriche del run;
- la stessa sequenza in `FROZEN` non registra niente e non compila niente; in `BASELINE`
  le regole attive non valgono, in `FROZEN` sì ma senza prove nuove;
- due smentite di fila sospendono la regola, e il documento dopo torna senza data;
- richiudere non vale doppio, scartare ritira le prove.

Il revert di una regola arriva con la PR 6, insieme alla UI.

### PR 5 — classificazione: memoria dei moduli

Regola `TEMPLATE_TYPE` (una per modulo e tipo), funzioni in `src/main/learning-templates.ts`,
segnale `template-memory` in `classify-v2.ts`. Scelte:

- **Prove dagli eventi di tipo**: un documento con impronta chiuso con un tipo sostiene la
  memoria di quel tipo e smentisce quella di ogni altro tipo dello stesso modulo; un tipo
  tolto le smentisce tutte. Uno scarto le ritira, come per le etichette.
- **Più severa delle etichette**: 3 revisioni concordi e nessuna smentita per attivarsi, e
  una smentita basta a sospendere. È la regola di 1.6 della specifica («mai auto-assegnare
  se esiste conflitto storico»), con un supporto più alto perché un tipo sbagliato cambia
  tutti i campi cercati.
- **Segnale limitato**: vale esattamente `auto_assign_threshold`. Da solo propone il tipo di
  un modulo che il registry non riconosce (il caso dei promemoria); non supera un hard
  negative, non vince un margine sotto il minimo, e non entra nel bonus di corroborazione.
- **Rielaborazione per impronta** (`reprocessQueueOfTemplate`), non per tipo: i documenti che
  cambiano sono quelli del modulo ancora senza tipo. Un tipo scelto a mano resta.
- **Audit**: le memorie offerte al classificatore finiscono in
  `metrics_json.classifier.templateRuleIds`; la timeline dice «dalla memoria del modulo».

Verificato in `tests/learning-flow.test.ts`: dopo tre revisioni il promemoria in coda si
classifica da sé e, con l'etichetta già attiva, arriva con la data; un modulo chiuso con un
altro tipo sospende la memoria e il documento in coda torna senza tipo; in `BASELINE` la
memoria non vale.

**Frasi del classificatore (`CLASSIFIER_POSITIVE`/`NEGATIVE`): rimandate.** Il pacchetto le
mette nella stessa fase, con `mergeClassifierConfig`. Non le ho fatte per tre ragioni:

1. Serve estrarre frasi distintive confrontando i documenti fra tipi diversi, e un reviewer
   desktop ne vede pochi per tipo: le frequenze su cui decidere se una frase distingue un
   tipo non ci sono ancora.
2. È la parte con più rischio di dati personali (una frase «distintiva» di un fornitore è
   spesso il suo nome) e di falsi segnali su tipi confondibili.
3. È la meno portabile: pratica-ai ha un altro classificatore (voti su titolo e lessico,
   segnali forti, regole di disambiguazione, voto LLM), e `ClassifierConfigV2` non esiste lì.

La memoria dei moduli copre il caso più frequente — lo stesso stampato che ritorna — senza
nessuno di questi rischi. Le frasi valgono una PR a sé quando ci saranno abbastanza
revisioni per misurarle; gli eventi `DOCUMENT_TYPE` le conservano già.
