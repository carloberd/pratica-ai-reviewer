# praticaai-reviewer

App desktop (Electron + React) per rivedere i documenti di un Google Drive: legge i
PDF e i DOCX in sola lettura, li classifica con il `documentType` del registry
PraticaAI, precompila i campi dichiarati dallo schema del tipo con evidenza verbatim,
e offre una UI di revisione con campi correggibili ed evidenze.

Tutto resta in locale: SQLite nella cartella dati dell'utente, PDF in cache su disco,
token Google cifrato nel portachiavi di sistema. Nessun dato esce dalla macchina.

---

## Requisiti

- Node 22 e pnpm 10+ (`corepack enable` se pnpm non c'è).
- macOS o Windows. Su Linux l'app gira da sorgente ma non è fra i target di build.
- Nessun binario di sistema: tesseract è la build wasm di `tesseract.js`, con i modelli
  italiano e inglese versionati in `resources/tessdata`.

```bash
pnpm install     # il postinstall ricompila better-sqlite3 per l'ABI di Electron
pnpm dev         # avvia l'app
```

---

## Setup Google Cloud

L'app usa OAuth 2.0 con PKCE e chiede **un solo scope**: `drive.readonly`. Non scrive
mai su Drive.

1. Apri la [Google Cloud Console](https://console.cloud.google.com/) e crea (o scegli)
   un progetto.
2. **API e servizi → Libreria**: abilita **Google Drive API**.
3. **API e servizi → Schermata consenso OAuth**:
   - tipo di utente **Esterno**;
   - stato di pubblicazione **In test**;
   - in **Utenti di test** aggiungi l'indirizzo Google del collega (e il tuo, se vuoi
     provare l'app col tuo Drive).
4. **Ambiti**: aggiungi `https://www.googleapis.com/auth/drive.readonly`.
5. **Credenziali → Crea credenziali → ID client OAuth**, tipo **Applicazione desktop**.
   Il tipo desktop accetta il redirect su `http://127.0.0.1:<porta>` senza doverlo
   registrare: l'app apre una porta effimera solo per il tempo del login.
6. Copia ID client e client secret in un file `.env` nella radice del repo:

```env
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

Il `.env` è in `.gitignore`. Per i pacchetti costruiti in CI non serve: le credenziali
ci finiscono dentro a build time, vedi sotto.

### Dove stanno le credenziali

Tre sorgenti, in ordine di precedenza:

| Sorgente | Quando |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` nell'ambiente | override al volo |
| file `.env` | sviluppo (radice del repo) e installazioni manuali (cartella dati utente) |
| cucite nel bundle a build time | pacchetti costruiti dai workflow |

L'ordine conta: un pacchetto già installato si può puntare su credenziali diverse con
un `.env` nella cartella dati, senza ricompilarlo.

Per i pacchetti, i workflow leggono i secret `GOOGLE_CLIENT_ID` e
`GOOGLE_CLIENT_SECRET` del repository (*Settings → Secrets and variables → Actions*) e
`electron.vite.config.ts` li scrive dentro il bundle del **processo main soltanto**: nel
preload e nel renderer non arrivano mai (D1). Su una release senza quei secret il
workflow si ferma — un'app che non può fare login è peggio di una build fallita. Su una
run manuale sono facoltativi, e il pacchetto che ne esce mostra la schermata di setup.

Un client OAuth di tipo desktop **non può custodire un segreto**: è la ragione per cui
esiste PKCE, e Google prevede che finisca dentro il binario. Chi apre un artefatto può
comunque estrarlo, quindi: repository privato, pacchetti non pubblicati in giro. Se un
segreto esce, si rigenera dalla Cloud Console e si ritaglia una release — non c'è dato
del Drive a rischio, perché la schermata di consenso in modalità test autorizza solo gli
utenti di test elencati.

> **Consenso in modalità test: il refresh token scade dopo 7 giorni.** È una regola di
> Google, non dell'app: il collega dovrà rifare l'accesso una volta a settimana finché
> la schermata di consenso resta "In test". Per toglierla di mezzo serve pubblicare
> l'app (e, con `drive.readonly`, passare dalla verifica Google).

---

## Comandi

| Comando | Cosa fa |
|---|---|
| `pnpm dev` | Avvia l'app con ricarica a caldo del renderer |
| `pnpm typecheck` | `tsc --noEmit` su main/preload e su renderer |
| `pnpm lint` / `pnpm lint:fix` | Biome |
| `pnpm test` | Vitest: nessuna credenziale, nessuna rete |
| `pnpm build` | Compila main, preload e renderer in `out/` |
| `pnpm dist` | Pacchetti mac (dmg, zip) e Windows (nsis, zip) in `release/` |
| `pnpm dist:mac` / `pnpm dist:win` | Solo una delle due piattaforme |
| `node scripts/make-fixtures.mjs` | Rigenera le fixture di `tests/fixtures/` |
| `node scripts/make-icon.mjs` | Rigenera `build/icon.png` |

Il gate è `pnpm typecheck && pnpm lint && pnpm test`.

### Tagliare una release

```bash
make patch    # 1.0.0 -> 1.0.1
make minor    # 1.0.0 -> 1.1.0
make major    # 1.0.0 -> 2.0.0
```

Il `Makefile` esegue il gate, bumpa `package.json`, committa, tagga, pusha e crea la
GitHub Release con `gh`. Da lì in poi non fa altro: è l'evento di release a far partire
i due workflow, che compilano sui rispettivi runner e allegano i pacchetti.

Il gate gira **prima** del bump e non dentro un hook: se fallisce non viene toccato
niente, né commit né tag né release da ritirare. Prima di muovere qualcosa controlla
anche di essere su `main`, con working tree pulito, allineato a `origin/main`, e che il
tag non esista già né in locale né su origin. Per tagliare da un altro ramo:
`make patch RELEASE_BRANCH=<ramo>`.

Serve la CLI [`gh`](https://cli.github.com/) autenticata.

### I workflow di build

Due workflow, uno per piattaforma, che girano ognuno sul proprio runner perché
entrambi gli installer si costruiscono nativamente:

| Workflow | Runner | Cosa produce |
|---|---|---|
| `.github/workflows/publish-windows.yml` | `windows-latest` | `praticaai-reviewer-<v>-setup.exe`, `praticaai-reviewer-<v>-win-x64.zip` |
| `.github/workflows/publish-macos.yml` | `macos-latest` | `praticaai-reviewer-<v>-mac-{arm64,x64}.dmg` |

Il runner macOS è arm64 e produce comunque entrambe le architetture: per la x64
electron-builder scarica l'Electron corrispondente, non serve un runner Intel.

Entrambi partono in due modi:

- **Su una GitHub Release pubblicata**: eseguono il gate, compilano e allegano i
  pacchetti alla release, uno per riga nella pagina dei download. È l'unico modo per
  avere una pagina di release: `make patch` la crea, e la creazione fa partire i due
  workflow.
- **A mano** (`workflow_dispatch`): stessi passi, ma i pacchetti restano allegati alla
  run invece che alla release — utile per provare una build senza pubblicare nulla. Ogni
  pacchetto è un artefatto a sé, così non si scarica anche quello che non serve.

La versione degli artefatti viene da `package.json`, non dal tag: prima di taggare
allinea `package.json`, altrimenti il workflow si ferma e lo dice. I nomi sono fissati
da `artifactName` in `electron-builder.yml` — piattaforma compresa, altrimenti lo zip
mac x64 e quello Windows x64 si sovrascriverebbero — così i workflow li verificano
invece di cercarli.

### Primo avvio dei pacchetti

Non ci sono firme di distribuzione: né un certificato Developer ID di Apple né uno di
Authenticode. Il bundle macOS riceve comunque una **firma ad-hoc** (`build/after-pack.js`),
senza la quale macOS presenterebbe l'app come *danneggiata* — non è un modo di dire: il
pacchetto conserverebbe la sola firma del linker che arriva col binario di Electron
mentre il bundle intorno è stato riscritto, e `codesign --verify` fallirebbe davvero.

Con la firma ad-hoc l'app è valida ma lo sviluppatore resta non verificato, quindi al
primo avvio serve un passaggio in più:

**macOS** — dopo aver trascinato l'app in `Applicazioni`:

```bash
xattr -dr com.apple.quarantine "/Applications/PraticaAI Reviewer.app"
```

Toglie l'attributo di quarantena che macOS mette su tutto ciò che arriva da internet.
In alternativa, al primo tentativo di apertura: *Impostazioni di Sistema → Privacy e
sicurezza → Apri comunque*.

**Windows** — SmartScreen mostra un avviso: *Ulteriori informazioni → Esegui comunque*.

Per togliere di mezzo entrambi i passaggi servono un Apple Developer Program (99 $/anno,
per firma Developer ID e notarizzazione) e un certificato Authenticode. Per due macchine
conosciute non vale la spesa.

---

## Come funziona

**Processo main** (Node): OAuth, Drive, filesystem, SQLite, estrazione del testo, OCR.
**Renderer** (React): solo UI, con `contextIsolation`, `sandbox` e senza Node. Non ha
token, non ha credenziali e non fa richieste di rete; il PDF lo riceve dalla cache
locale attraverso il ponte IPC. Ogni canale ha un handler solo, valida l'ingresso con
zod e risponde con `{ ok: true, data }` oppure `{ ok: false, error: { code, message } }`.
I messaggi d'errore vengono ripuliti da tutto ciò che somiglia a una credenziale prima
di lasciare il main.

**Accesso.** Il consenso Google si apre nel **browser di sistema**, non in una finestra
dell'app: Google rifiuta il flusso OAuth dentro un browser incorporato («Questo browser
o questa app potrebbero non essere sicuri») e riconosce come tale una finestra di
Electron, qualunque user agent dichiari. È anche la scelta migliore per chi accede,
perché la password finisce in una finestra di cui si possono verificare lucchetto e
indirizzo, e l'app non la vede mai passare. Il redirect torna comunque sul loopback e lo
scambio codice→token avviene nel main. Se il consenso non arriva entro cinque minuti la
porta si chiude e il login va ripetuto.

**Download su richiesta.** «Documenti» mostra l'elenco dell'account — `files.list`
paginata su PDF e DOCX fuori dal cestino — e basta: è solo metadato, non scarica niente.
Il contenuto arriva al doppio clic su una riga, un file per volta, che lo scarica in
cache, lo analizza e apre la revisione. Tirare giù l'intero Drive in un colpo
riempirebbe il disco di documenti che nessuno aprirà.

Ogni file è deduplicato per `drive_file_id` — l'id che Drive dà al file, salvato
`UNIQUE NOT NULL` su `documents` e mai riscritto dalle sincronizzazioni successive.
È la chiave con cui ogni riga del dataset si risale al file originale, anche fuori
dall'app: `https://drive.google.com/file/d/<drive_file_id>/view`. Riaprire un file non
riscarica nulla, a meno che su Drive non ci sia una versione più recente. «Libera spazio», nella vista di revisione,
toglie la copia locale e lascia intatti dati estratti ed evidenze: il file si riscarica
riaprendolo. L'elenco mostra, per ogni riga, se il file è in locale, da aggiornare o
solo analizzato, e in testa quanto spazio occupa la cache.

**Due motori, scelti da variabile d'ambiente.** `CLASSIFIER_ENGINE` ed
`EXTRACTION_ENGINE` valgono `v2` se non impostate; `v1` riporta il comportamento di
prima ed è la scappatoia se il v2 dà problemi. Si leggono come le credenziali: prima
l'ambiente, poi il `.env`. Un valore diverso da `v1`/`v2` ferma l'avvio. Con entrambi a
`v1` i JSON del registry v2 non vengono nemmeno caricati.

**Classificazione v2** (deterministica, nessun LLM). Combina più indizi sulle prime
pagine (`max_pages` in `resources/registry/v2/classifier_signals_v2.json`): alias del
registry pesati per posizione (zona del titolo o resto del testo) e specificità, segnali
positivi, contrari ed esclusivi configurati per 11 classi che si confondono (CU, UNILAV,
patente a crediti…), il nome del file solo come conferma. Assegna il tipo solo se il
punteggio supera la soglia **e** stacca abbastanza il secondo candidato; altrimenti il
documento resta `UNKNOWN` e la timeline dice perché (`BELOW_THRESHOLD`, `LOW_MARGIN`,
`FILENAME_ONLY`, `HARD_NEGATIVE`, `NO_SIGNAL`) con miglior candidato, secondo e margine.

**Classificazione v1.** Phrase match di `canonical_name`, `aliases` e `synonyms` sulla
prima pagina (0,90) e sul nome del file (0,70); sotto 0,75 il tipo resta da assegnare.

**Precompilazione v2.** I campi sono quelli del profilo del tipo
(`class_extraction_profiles_v2.json`, 500 profili su un'ontologia di 248 campi), ognuno
col suo ruolo: obbligatorio, principale, opzionale, condizionale. I 16 tipi del registry
senza profilo esplicito ricevono un profilo ricavato dal loro schema v1
(`LEGACY_FALLBACK`). **Senza tipo non si estrae niente**: la scheda resta vuota finché il
tipo non viene assegnato a mano, e l'assegnazione rielabora subito il documento. Il
valore si cerca dopo l'etichetta sulla stessa riga o, se la riga finisce con
l'etichetta, sulla successiva, con un lettore per tipo (date, importi, interi, decimali,
identificativi, testo). Fra due campi che leggono la stessa riga vince l'etichetta più
specifica; a parità, o con due valori diversi per la stessa etichetta, il campo va in
`CONFLICT`. I campi ripetuti (righe, rate, garanzie) finiscono in `field_items`, un
elemento per riga. Ogni esecuzione lascia un rigo in `extraction_runs` con motore,
versione dei profili, obbligatori mancanti, conflitti e metriche.

**Precompilazione v1.** I campi dichiarati dallo schema del tipo, i 4 universali se il
tipo manca, con le euristiche di `src/main/extract/heuristics.ts`. Il testo, per
entrambi, viene dal text layer del PDF, da mammoth per i DOCX, o da tesseract per le
pagine sotto i 100 caratteri.

**Nessun valore senza evidenza.** Ogni campo precompilato punta a una riga verbatim del
documento, con le coordinate quando il text layer le espone. Se l'evidenza non si trova,
il campo resta vuoto: un dato che il revisore non può verificare costa più di un campo
da riempire a mano.

**Confidence.** v2: 0,85 col valore sulla riga dell'etichetta, 0,80 sulla riga
successiva, meno 0,18 per ogni validatore fallito; sotto 0,85 il campo è `NEEDS_REVIEW`,
sopra `AUTO_ACCEPTED`. v1: 0,85 con una keyword di contesto, 0,70 col solo pattern. In
entrambi meno 0,10 se il testo viene da OCR. La confidence del documento è la media dei campi valorizzati; le
bande sono HIGH ≥ 0,90, MEDIUM ≥ 0,75, LOW sotto. Sono euristiche dichiarate, da
calibrare sui documenti veri.

**Revisione.** I campi sono modificabili: il valore precompilato resta accanto a quello
corretto, e riscrivere lo stesso valore non conta come correzione. Ogni modifica è già a
database nel momento in cui si esce dal campo — i tasti in fondo non salvano i dati,
dichiarano l'esito.

Gli esiti sono due. **Salva** porta il documento a `REVIEWED`: tipo e campi sono a
database e il documento entra nel dataset dei test futuri. **Scarta** lo porta a
`DISCARDED`: i dati estratti restano, ma il documento resta fuori dal dataset. Non c'è
un terzo tasto perché non c'è una terza scelta: approvare e «confermare con correzione»
finivano nello stesso stato, e quale delle due fosse dipendeva solo dai campi toccati.
Quella differenza la calcola `buildReviewPayload`, che emette
`decision: APPROVE | CORRECT | REJECT` e porta solo i campi cambiati, con before/after e
provenienza (sorgente del testo, evidenza, confidence): la forma
`{ decision, corrections, note }` attesa da
`POST /v1/document-understandings/{id}/reviews` resta valida senza chiederla a nessuno.

**Compilare dal documento.** Il campo su cui sta il cursore resta attivo anche dopo
aver perso il fuoco, perché selezionare sul documento glielo fa perdere per forza: quello
che si seleziona sulla pagina ci finisce dentro come correzione. Sui PDF con testo nativo
basta la selezione, sulle scansioni — dove non c'è testo da selezionare — si evidenzia
un'area, che viene rasterizzata a scala 3 e letta dallo stesso worker tesseract della
precompilazione. Il PDF in cache non viene mai toccato: resta identico byte per byte a
quello su Drive.

---

## Dove finiscono i dati

Tutto sotto la cartella dati dell'app
(`~/Library/Application Support/praticaai-reviewer` su macOS,
`%APPDATA%\praticaai-reviewer` su Windows):

| File | Contenuto |
|---|---|
| `praticaai-reviewer.db` | documenti, campi, evidenze, eventi, indice FTS5 |
| `cache/<drive_file_id>.pdf\|.docx` | copia locale dei file di Drive |
| `tokens.bin` | refresh token, cifrato con `safeStorage` (Keychain / DPAPI) |
| `tessdata-cache/` | modelli tesseract scompattati |
| `.env` | credenziali OAuth, se l'app è impacchettata |

Per ripartire da zero basta cancellare la cartella. Per disconnettere l'account c'è
«Esci» nel menu dell'avatar, che revoca il token oltre a cancellarlo.

---

## Da sapere sulla v1

**Manopole di calibrazione.** Le soglie stanno in `src/shared/confidence.ts`
(`BAND_THRESHOLDS`, `TYPE_MATCH_THRESHOLD`) e le keyword di contesto in
`src/main/extract/heuristics.ts` (`FIELD_SPECS`). Con i punteggi attuali un match che
compare **solo** nel nome del file vale 0,70 e resta sotto la soglia di 0,75: è voluto,
il nome di un file è un indizio e non una prova. Se sui documenti veri risultasse troppo
severo, abbassare `TYPE_MATCH_THRESHOLD` a 0,70 è la prima cosa da provare.

**Divergenza dal registry.** `package_count` e `consumption` sono dichiarati `number`
negli schemi ma qui sono trattati come stringhe: in pratica portano un'unità di misura
(«12 colli», «540 kWh») che una normalizzazione numerica butterebbe via.

**Correzioni e rielaborazione.** Una correzione umana è legata al nome del campo e
sopravvive a una nuova estrazione dello stesso documento; lo stesso vale per un tipo
assegnato a mano, che non viene sovrascritto da un match automatico. La migrazione 0004
rinomina i 40 campi v1 sugli id dell'ontologia (`document_number` → `document.number`),
e la pipeline ritrova una correzione anche sotto l'altro nome, così cambiare motore non
la perde. Col v2 una correzione su un campo che il nuovo profilo non chiede resta come
campo a sé, e quella su un elemento ripetuto torna sullo stesso indice. All'avvio col v2
i documenti in coda con la copia in cache che non sono mai passati da questa versione dei
profili vengono rielaborati in sottofondo; quelli già revisionati o scartati no.

**OCR.** Copre le pagine *scansionate*, cioè quelle fatte di immagini: il motore prende
l'immagine che la pagina già contiene invece di ri-rasterizzarla. Una pagina senza testo
e senza immagini (per esempio solo grafica vettoriale) non produce testo.

**Accessibilità.** L'area da leggere con OCR si evidenzia trascinando con il mouse; in
v1 non c'è un equivalente da tastiera. Sui PDF con testo nativo la selezione funziona
anche da tastiera, perché è la selezione normale del browser.

**Pacchetti non firmati.** `pnpm dist` produce dmg e installer non firmati: al primo
avvio macOS chiede conferma e Windows mostra SmartScreen. È deliberato — l'app è per due
macchine note, non per distribuzione.

---

## Fuori ambito, e dove si innesterebbe

Non implementato in v1, per scelta:

- **Scrittura su Drive.** Lo scope richiesto è solo `drive.readonly`.
- **DOCX con resa di pagina.** Solo testo estratto, quindi niente evidenze con
  coordinate né OCR su area per i DOCX; la selezione del testo compila comunque i campi.
- **Estrazione con LLM.** Il modulo di precompilazione
  (`src/main/extract/heuristics.ts`) ha già la forma giusta per essere sostituito dal
  fact reader del Document Brain: prende i campi richiesti, restituisce candidati con
  evidenza. `createDocumentProcessor` non cambierebbe.
- **Invio della review al Document Brain.** `buildReviewPayload` produce già il payload
  compatibile con `POST /v1/document-understandings/{id}/reviews`; manca solo la
  chiamata.
- **Multi-account** e **download in blocco.** Un account per volta, e un file per volta:
  non esiste un comando che scarica tutto il Drive.

---

## Origine del codice

La UI di revisione parte dal modulo **PraticaAI Document Review v5.2**
(`document-review-shell.tsx`, il suo CSS e i contratti di `types/document-review.ts`),
adattato ai dati di questa app: Drive al posto di pratica e cliente, IPC al posto di
`fetch('/api/...')`. Il gap che quel modulo dichiarava aperto — «Conferma con
correzione» senza editor dei campi — qui è chiuso, e con l'editor quel tasto non serviva
più: le tre decisioni del v5.2 sono diventate le due azioni che il revisore prende
davvero, Salva e Scarta. Il guscio è poi cambiato: i menu
stanno in una navbar orizzontale invece che in una sidebar, e in revisione il documento
è sempre visibile accanto alle schede Dati, History ed Evidenze.

I file in `resources/registry/` sono uno **snapshot** del registry PraticaAI
(511 tipi, vedi `SNAPSHOT.txt`); quelli in `resources/registry/v2/` vengono dal pacchetto
Classifier v2 + Extraction Brain v2 (vedi `v2/SNAPSHOT.txt`), con i profili ancora in
stato di bozza. Il repo non dipende dal monorepo PraticaAI e non ne
importa nulla: quei JSON sono dati, non codice.
