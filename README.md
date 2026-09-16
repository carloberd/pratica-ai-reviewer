# praticaai-reviewer

App desktop (Electron + React) per rivedere i documenti di un Google Drive: legge i
PDF e i DOCX in sola lettura, li classifica con il `documentType` del registry
PraticaAI, precompila i campi dichiarati dallo schema del tipo con evidenza verbatim,
e offre una UI di revisione con campi correggibili, evidenze e annotazioni.

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

Il `.env` è in `.gitignore`. Nell'app impacchettata lo stesso file va in
`~/Library/Application Support/praticaai-reviewer/.env` (macOS) o
`%APPDATA%\praticaai-reviewer\.env` (Windows). Senza credenziali l'app si apre lo
stesso e mostra in chiaro cosa manca e dove metterlo.

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

### Release

Due workflow, uno per piattaforma, che girano ognuno sul proprio runner perché
entrambi gli installer si costruiscono nativamente:

| Workflow | Runner | Cosa produce |
|---|---|---|
| `.github/workflows/publish-windows.yml` | `windows-latest` | `praticaai-reviewer-<v>-setup.exe`, `praticaai-reviewer-<v>-win-x64.zip` |
| `.github/workflows/publish-macos.yml` | `macos-latest` | `praticaai-reviewer-<v>-mac-{arm64,x64}.{dmg,zip}` |

Il runner macOS è arm64 e produce comunque entrambe le architetture: per la x64
electron-builder scarica l'Electron corrispondente, non serve un runner Intel.

Entrambi partono in due modi:

- **Su una GitHub Release pubblicata**: eseguono il gate, compilano e allegano i
  pacchetti alla release.
- **A mano** (`workflow_dispatch`): stessi passi, ma gli artefatti restano allegati alla
  run invece che alla release — utile per provare una build senza pubblicare nulla.

La versione degli artefatti viene da `package.json`, non dal tag: prima di taggare
allinea `package.json`, altrimenti il workflow si ferma e lo dice. I nomi sono fissati
da `artifactName` in `electron-builder.yml` — piattaforma compresa, altrimenti lo zip
mac x64 e quello Windows x64 si sovrascriverebbero — così i workflow li verificano
invece di cercarli.

I pacchetti non sono firmati: al primo avvio macOS chiede conferma e Windows mostra
SmartScreen.

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

**Download su richiesta.** «File su Drive» mostra l'elenco dell'account — `files.list`
paginata su PDF e DOCX fuori dal cestino — e basta: è solo metadato, non scarica niente.
Il contenuto arriva al doppio clic su una riga, un file per volta, che lo scarica in
cache, lo analizza e apre la revisione. Tirare giù l'intero Drive in un colpo
riempirebbe il disco di documenti che nessuno aprirà.

Ogni file è deduplicato per `drive_file_id`: riaprirlo non riscarica nulla, a meno che
su Drive non ci sia una versione più recente. «Libera spazio», nella vista di revisione,
toglie la copia locale e lascia intatti dati estratti, evidenze e annotazioni: il file si
riscarica riaprendolo. L'elenco mostra, per ogni riga, se il file è in locale, da
aggiornare o solo analizzato, e in testa quanto spazio occupa la cache.

**Classificazione** (deterministica, nessun LLM). Phrase match di `canonical_name`,
`aliases` e `synonyms` del registry sul testo normalizzato della prima pagina (0,90) e
sul nome del file (0,70), vince il massimo fra i due e, a parità, l'alias più lungo.
Sotto 0,75 il tipo non viene assegnato e resta da scegliere a mano nella UI.

**Precompilazione.** Vengono chiesti solo i campi dichiarati dallo schema del tipo (i 4
universali più gli specifici); senza tipo restano i 4 universali. Il testo viene dal
text layer del PDF, da mammoth per i DOCX, o da tesseract per le pagine sotto i 100
caratteri. Le euristiche sono per tipo semantico: date normalizzate a `yyyy-mm-dd`,
importi a decimale con punto, codice fiscale e partita IVA, numeri di documento e di
protocollo, e il pattern `<etichetta>: <valore>` per le stringhe.

**Nessun valore senza evidenza.** Ogni campo precompilato punta a una riga verbatim del
documento, con le coordinate quando il text layer le espone. Se l'evidenza non si trova,
il campo resta vuoto: un dato che il revisore non può verificare costa più di un campo
da riempire a mano.

**Confidence.** 0,85 con una keyword di contesto, 0,70 col solo pattern, meno 0,10 se il
testo viene da OCR. La confidence del documento è la media dei campi valorizzati; le
bande sono HIGH ≥ 0,90, MEDIUM ≥ 0,75, LOW sotto. Sono euristiche dichiarate, da
calibrare sui documenti veri.

**Revisione.** I campi sono modificabili: il valore precompilato resta accanto a quello
corretto, e riscrivere lo stesso valore non conta come correzione. Il payload della
decisione porta solo i campi cambiati, con before/after e provenienza (sorgente del
testo, evidenza, confidence), e mantiene la forma
`{ decision, corrections, note }` attesa da
`POST /v1/document-understandings/{id}/reviews`.

**Annotazioni.** Evidenziazioni e note si disegnano sul PDF e vivono in SQLite: il file
in cache resta identico byte per byte a quello su Drive. «Esporta PDF annotato» scrive
una copia separata con i riquadri numerati e una pagina finale che elenca le note.

---

## Dove finiscono i dati

Tutto sotto la cartella dati dell'app
(`~/Library/Application Support/praticaai-reviewer` su macOS,
`%APPDATA%\praticaai-reviewer` su Windows):

| File | Contenuto |
|---|---|
| `praticaai-reviewer.db` | documenti, campi, evidenze, annotazioni, eventi, indice FTS5 |
| `cache/<drive_file_id>.pdf\|.docx` | copia locale dei file di Drive |
| `tokens.bin` | refresh token, cifrato con `safeStorage` (Keychain / DPAPI) |
| `tessdata-cache/` | modelli tesseract scompattati |
| `.env` | credenziali OAuth, se l'app è impacchettata |

Per ripartire da zero basta cancellare la cartella. Per disconnettere l'account c'è
«Esci» nella barra laterale, che revoca il token oltre a cancellarlo.

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
assegnato a mano, che non viene sovrascritto da un match automatico.

**OCR.** Copre le pagine *scansionate*, cioè quelle fatte di immagini: il motore prende
l'immagine che la pagina già contiene invece di ri-rasterizzarla. Una pagina senza testo
e senza immagini (per esempio solo grafica vettoriale) non produce testo.

**Accessibilità.** Le annotazioni si creano trascinando con il mouse; in v1 non c'è un
equivalente da tastiera.

**Pacchetti non firmati.** `pnpm dist` produce dmg e installer non firmati: al primo
avvio macOS chiede conferma e Windows mostra SmartScreen. È deliberato — l'app è per due
macchine note, non per distribuzione.

---

## Fuori ambito, e dove si innesterebbe

Non implementato in v1, per scelta:

- **Scrittura su Drive.** Lo scope richiesto è solo `drive.readonly`.
- **DOCX con resa di pagina.** Solo testo estratto, quindi niente annotazioni sui DOCX.
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

La UI di revisione è il porting del modulo **PraticaAI Document Review v5.2**
(`document-review-shell.tsx`, il suo CSS e i contratti di `types/document-review.ts`),
adattato ai dati di questa app: Drive al posto di pratica e cliente, IPC al posto di
`fetch('/api/...')`. Il gap che quel modulo dichiarava aperto — «Conferma con
correzione» senza editor dei campi — qui è chiuso.

I file in `resources/registry/` sono uno **snapshot** del registry PraticaAI
(511 tipi, vedi `SNAPSHOT.txt`). Il repo non dipende dal monorepo PraticaAI e non ne
importa nulla: quei JSON sono dati, non codice.
