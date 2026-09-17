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

Non c'è ancora un canale IPC né UI per la modalità: arrivano con la PR 6. Finché la PR 3
non registra le revisioni, il deposito resta vuoto.
