# praticaai-reviewer

App desktop (Electron + React) per rivedere i documenti di un Google Drive: legge i
PDF e i DOCX in sola lettura, li classifica con il `documentType` del registry
PraticaAI, precompila i campi dichiarati dallo schema del tipo con evidenza verbatim,
e offre una UI di revisione con campi correggibili ed evidenze.

Tutto resta in locale: SQLite nella cartella dati dell'utente, PDF in cache su disco,
token Google cifrato nel portachiavi di sistema. Nessun dato esce dalla macchina.

---

## Perché esiste, e dove va a finire

L'obiettivo è **un tool di revisione che impari da solo**: ogni correzione del revisore
deve lasciare qualcosa al motore, così che il documento dopo arrivi già più giusto di
quello prima. Non è un annotatore con sopra qualche euristica — è l'apprendimento la
ragione del progetto, e il resto (Drive, OCR, la scheda di revisione) è l'impalcatura
che serve a raccoglierlo. Quello che il learner impara sta in [Apprendimento
locale](#apprendimento-locale).

Il percorso è in tre tempi, e conviene tenerli distinti perché chiedono cose diverse al
codice.

**Adesso: costruire il dataset.** L'app è in mano a un collega che sta annotando un
corpus ampio di documenti reali — tipo assegnato a mano, campi estratti verificati uno
per uno. Il prodotto di questa fase non è l'app: è il **dataset annotato corretto**, che
esce da [«Esporta il dataset»](#export-del-dataset-annotato). Ne segue una priorità
concreta: fra una funzione che fa imparare di più e una che rende l'annotazione più
veloce e meno ambigua, in questa fase vince la seconda, e **nessuna delle due vale una
riga di dato sbagliata nell'export**. Un valore annotato male è peggio di un campo
lasciato vuoto: il vuoto si vede, l'errore no, e va a finire nel training.

**Poi: misurare l'apprendimento su quel corpus.** Finché il dataset non c'è, ogni
misura del learner gira su fixture scritte a mano e prova solo che il codice fa quello
che il test dice. Le tre modalità del learner (`LEARNING`, `FROZEN`, `BASELINE`)
esistono apposta per il confronto pre/post su documenti mai visti: valgono quando ci
sono i documenti veri da passarci. Il banco su cui passarli c'è già: [Misurare su un
corpus reale](#misurare-su-un-corpus-reale).

**Alla fine: portare il tool dentro pratica-ai**, e lì usare un LLM dove l'euristica
non arriva — sui documenti senza un modulo che si ripete, o per proporre l'ancora che il
learner da solo non ricava. L'innesto è già previsto e non è una riscrittura: vedi [Fuori
ambito, e dove si innesterebbe](#fuori-ambito-e-dove-si-innesterebbe). Due conseguenze
sul codice di oggi: quello che il learner impara va tenuto in una forma **esportabile e
leggibile fuori da qui** (regole, non pesi), e il confine fra «cosa ho imparato» e «come
lo applico» va tenuto netto, perché è lì che un LLM si infila.

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
| `pnpm benchmark:pilot` | Benchmark dell'estrazione su un corpus reale fuori dal repository: vedi [Misurare su un corpus reale](#misurare-su-un-corpus-reale) |
| `pnpm dist` | Pacchetti mac (dmg, zip) e Windows (nsis, zip) in `release/` |
| `pnpm dist:mac` / `pnpm dist:win` | Solo una delle due piattaforme |
| `node scripts/make-fixtures.mjs [nomi…]` | Rigenera le fixture di `tests/fixtures/`, o solo quelle nominate: rigenerare un PDF ne cambia lo sha-256 |
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

**Download su richiesta.** «Documenti» mostra Drive com'è, una cartella per volta: le tre
radici della barra laterale di Drive — «Il mio Drive», «Condivisi con me», «Drive
condivisi» — come schede, e sotto il percorso della cartella aperta. Ogni cartella è una
`files.list` paginata sui figli diretti (sottocartelle, PDF e DOCX fuori dal cestino),
con le cartelle in cima e poi i file, in ordine di nome; i Drive condivisi arrivano da
`drives.list`. Le scorciatoie si aprono come l'originale: a una cartella ci si entra, a un
documento si legge coi metadati del bersaglio. È solo metadato, non scarica niente, e non
visita l'albero intero: si scende un livello per volta. Il doppio clic su una cartella la
apre; su un file lo scarica in cache, lo analizza e apre la revisione. Tirare giù l'intero
Drive in un colpo riempirebbe il disco di documenti che nessuno aprirà.

Ogni file è deduplicato per `drive_file_id` — l'id che Drive dà al file, salvato
`UNIQUE NOT NULL` su `documents` e mai riscritto dalle sincronizzazioni successive.
È la chiave con cui ogni riga del dataset si risale al file originale, anche fuori
dall'app: `https://drive.google.com/file/d/<drive_file_id>/view`. Riaprire un file non
riscarica nulla, a meno che su Drive non ci sia una versione più recente. «Libera spazio», nella vista di revisione,
toglie la copia locale e lascia intatti dati estratti ed evidenze: il file si riscarica
riaprendolo. L'elenco mostra, per ogni riga, se il file è in locale, da aggiornare o
solo analizzato, e in testa quanto spazio occupa la cache.

**Il tipo lo sceglie il revisore.** Il registry non ha più i segnali con cui un
classificatore tirava a indovinare dal testo: sono due file, i campi e la mappa «tipo →
campi», e nient'altro. Un documento arriva senza tipo e resta così finché qualcuno non lo
apre e lo assegna; l'assegnazione rielabora subito il documento.

**L'eccezione è la memoria dei moduli.** Quando lo stesso stampato è stato chiuso tre
volte con lo stesso tipo, il learner locale attiva una regola `TEMPLATE_TYPE` e da lì in
poi quel modulo arriva col tipo già proposto (confidenza 0,74, pesata sulla somiglianza
della testata). Non è una classificazione dal testo: è la decisione che i revisori hanno
già preso su quel modulo. Confermarla è un'altra revisione concorde; chiuderlo con un
altro tipo sospende la regola e il modulo torna senza tipo.

**Precompilazione.** I campi sono quelli che la mappa chiede per quel tipo
(`document_fields.json`, 171 classi canoniche su un'ontologia di 454 campi), ognuno col
suo ruolo: obbligatorio o opzionale. Un tipo che la mappa non elenca non ha campi da
estrarre, e la timeline lo dice. Quelle mappe sono per lo più scritte a tavolino: quanto
valgano lo dicono le annotazioni, e si correggono dalla scheda «Campi da estrarre» della
revisione (sotto).
**Senza tipo non si estrae niente**: la scheda resta vuota finché il
tipo non viene assegnato a mano, e l'assegnazione rielabora subito il documento. Il
valore si cerca dopo l'etichetta sulla stessa riga o, se la riga finisce con
l'etichetta, sulla successiva, con un lettore per tipo (date, importi, interi, decimali,
identificativi, testo). La riga «finisce con l'etichetta» anche quando dopo la barra
resta la stessa etichetta in un'altra lingua — `COGNOME/SURNAME`,
`CITTADINANZA/NATIONALITY` — come la scrivono i documenti d'identità: ogni pezzo dopo la
barra dev'essere un'etichetta che il registry dichiara **per quel campo**, altrimenti
resta un'intestazione di colonna e la riga sotto è il suo primo dato, non un valore.
Su un documento che dichiara le parti a blocchi — una fattura elettronica resa dallo
stilo SdI scrive `Cedente prestatore (fornitore)` e `Cessionario committente (cliente)` —
la **sezione** corrente si propaga di riga in riga (`sections` in `fields.json`) e un campo `issuer.*` o `recipient.*` legge solo le righe
della sua parte: `Denominazione` da sola non distingue l'emittente dal destinatario.
Apre una sezione soltanto una riga che è **solo** l'intestazione, mai un'etichetta con il
suo valore; due intestazioni sulla stessa riga non ne aprono nessuna, perché lì la parte
dipende dalla colonna. Un documento senza intestazioni si legge esattamente come prima.
Dopo una coda bilingue il valore si legge anche sulla stessa riga senza i due punti
(`COGNOME/SURNAME ROSSI`), che su quei moduli non arrivano mai: si ferma dove comincia la
colonna dopo, cioè all'etichetta di un altro campo del profilo o alla prossima parola
bilingue (`SESSO/SEX`), così una riga che l'OCR ha fuso non finisce dentro un campo solo. Un importo è negativo solo se il meno è attaccato al numero o
alla valuta (`-1.234,56`, `€ -100,00`): `Totale - 100,00` resta positivo. Un importo si
legge solo fino a dove comincia il campo accanto, e su una riga di tabella — due importi
separati da uno stacco di colonna, come il riepilogo IVA di una fattura — non si legge
affatto: quale colonna sia quel campo non si sa, e un numero sbagliato accettato da solo
è peggio di un campo vuoto. I validatori
sono quelli dell'ontologia, salvo dove il profilo del tipo li sostituisce
(`field_validator_overrides`): sulla nota di credito un totale negativo non è un errore,
e lo schema esportato non lo dichiara non negativo. I validatori controllano che una data
esista, che un importo non sia negativo, l'IBAN col checksum mod 97, la partita IVA con la
cifra di controllo e il codice fiscale col carattere di controllo (omocodia compresa; `IT`
davanti alle 11 cifre non conta), la targa nel formato in vigore dal 1994 e il telaio di 17
caratteri. Dove il campo è solo partita IVA (`*.vat_number`, su fattura e visura) un codice
fiscale di persona non passa: `tax_id_format` accetta l'uno e l'altro, `vat_number_format`
solo le 11 cifre. Un validatore fallito non toglie il valore: lo manda in revisione. Fra due campi che leggono la stessa
riga vince l'etichetta più specifica; a parità, o con due valori diversi per la stessa
etichetta, il campo va in `CONFLICT`. L'eccezione è «C.F. e P.IVA 01234567890»: partita IVA
e codice fiscale della stessa parte prendono lo stesso numero dalla stessa riga, senza
conflitto. Emittente e destinatario invece hanno le stesse etichette, e una partita IVA li
manda in `CONFLICT` tutti e due: il motore non indovina di chi è. Una riga che è soltanto
l'etichetta di un campo del profilo non è il valore di nessuno: se l'OCR perde il cognome
di una carta d'identità, sotto «COGNOME / SURNAME» c'è «NOME / NAME», e il cognome resta
vuoto invece di prenderla. Sui documenti d'identità cognome e nome sono due campi
(`person.last_name`, `person.first_name`), e numero, rilascio e scadenza stanno sulle chiavi
generiche `document.*`. I campi ripetuti (righe, rate, garanzie) finiscono
in `field_items`, un elemento per riga. Ogni esecuzione lascia un rigo in `extraction_runs` con motore,
versione dei profili, obbligatori mancanti, conflitti e metriche. Un campo che il profilo
chiede e l'ontologia non descrive non si può cercare — non si sa con che etichette né con
che lettore — ma resta nel run: campo vuoto con `UNKNOWN_FIELD` fra gli errori di
validazione, `UNKNOWN_FIELD:<id>` fra i conflitti, e fra gli obbligatori mancanti se il
profilo lo dichiara tale. Altrimenti la copertura del run direbbe 1,0 su un obbligatorio
mai cercato.

**Precompilazione v1.** I campi dichiarati dallo schema del tipo, i 4 universali se il
tipo manca, con le euristiche di `src/main/extract/heuristics.ts`. Il testo, per
entrambi, viene dal text layer del PDF, da mammoth per i DOCX, o da tesseract per le
pagine sotto i 100 caratteri.

**Nessun valore senza evidenza.** Ogni campo precompilato punta a una riga verbatim del
documento, con le coordinate quando il text layer le espone. Se l'evidenza non si trova,
il campo resta vuoto: un dato che il revisore non può verificare costa più di un campo
da riempire a mano.

**Un'eccezione sola, dichiarata: la scadenza della formazione.** Un attestato dice quando
il corso è stato fatto, non quando scade: la scadenza dipende dalla normativa, e il
revisore la calcolava a mano. Il motore ora la propone — cinque anni dal rilascio per la
formazione generale e specifica dei lavoratori — **solo** se il documento non la scrive e
solo per i corsi che la tabella conosce (`src/shared/training-expiry.ts`). Una scadenza
scritta sul documento vince sempre. Quel valore non ha evidenza, perché nel documento non
c'è: arriva al revisore marcato «dedotto» e sotto la soglia di accettazione automatica, e
nel dataset esce con `origin: "COMPUTED"`, che è quello che lo tiene separato da una
lettura riuscita quando si misura l'estrazione. Gli altri corsi (preposto, antincendio,
primo soccorso, lavori in quota, spazi confinati, DPI di terza categoria, RLS) non hanno
una riga: la scrive chi conosce la norma in vigore, con il riferimento accanto. Meglio un
campo vuoto che una data inventata.

**Confidence.** v2: 0,85 col valore sulla riga dell'etichetta, 0,80 sulla riga
successiva, meno 0,18 per ogni validatore fallito; 0,60 per un valore dedotto; sotto 0,85 il campo è `NEEDS_REVIEW`,
sopra `AUTO_ACCEPTED`. v1: 0,85 con una keyword di contesto, 0,70 col solo pattern. In
entrambi meno 0,10 per i campi che vengono da una pagina letta con OCR — la penalità è
della pagina, non del documento: un allegato scansionato in fondo a un PDF non declassa i
campi letti dal text layer delle altre pagine, che altrimenti scenderebbero sotto la soglia
di accettazione automatica. La confidence del documento è la media dei campi valorizzati; le
bande sono HIGH ≥ 0,90, MEDIUM ≥ 0,75, LOW sotto. Sono euristiche dichiarate, da
calibrare sui documenti veri.

**Revisione.** I campi sono modificabili: il valore precompilato resta accanto a quello
corretto, e riscrivere lo stesso valore non conta come correzione. Svuotare un valore
proposto invece sì: il motore aveva letto qualcosa che nel documento non c'è. Ogni
modifica è già a database nel momento in cui si esce dal campo — i tasti in fondo non
salvano i dati, dichiarano l'esito.

Accanto a ogni campo, e a ogni riga di un campo ripetuto, la scheda dice se il valore
**corrente** non passa i validatori del tipo: un IBAN col codice di controllo sbagliato, una
partita IVA con due cifre scambiate, un codice fiscale con un carattere di troppo. Il
controllo gira ogni volta che la revisione legge il documento (`validateFieldValue`), sulla
correzione se c'è e sulla proposta altrimenti. Quello che si scrive si controlla quindi
appena si esce dal campo, e un validatore migliorato vale anche sui documenti già chiusi.
È un avviso e non blocca niente: un documento può riportare davvero un codice sbagliato, e
allora il valore giusto da trascrivere è quello.

La scheda Dati è fatta per controllare in fretta, senza togliere niente al controllo:

- **Evidenza cliccabile.** Sotto ogni valore proposto c'è la sua origine, pagina e riga.
  Il clic porta il documento a quel punto senza cambiare scheda: col rettangolo salvato
  si evidenzia la riga; senza coordinate si cerca la riga nel text layer della pagina; se
  non si trova nemmeno lì si arriva alla pagina e la si segnala intera. Le scansioni le
  coordinate ce l'hanno anche loro, da quando l'OCR restituisce i riquadri delle righe.
  Nei DOCX, che non hanno pagine, la riga si evidenzia nel testo.
- **I campi vuoti in cima.** Quelli dove il motore non ha proposto niente stanno in un
  gruppo a sé, obbligatori prima, col contatore di quanti restano vuoti. Il gruppo
  dipende dalla proposta del motore, non dal valore: un campo compilato a mano non salta
  altrove mentre ci si lavora. Nessun campo si nasconde.
- **Candidati di tipo.** Quando il tipo resta `UNKNOWN`, o il classificatore l'ha
  assegnato con un margine sotto il doppio del minimo, la scheda tipo mostra i primi
  candidati col punteggio, il motivo e le frasi che li suggeriscono, ognuna cliccabile
  come un'evidenza. Si assegna dalla lista o cercando fra tutti i tipi; la scelta del
  revisore vale sempre. Negli altri casi i candidati restano consultabili, chiusi.
- **Campi ripetuti.** Righe fattura, rate, garanzie: una voce per riga, ognuna con la
  sua evidenza. Una riga proposta si corregge o si toglie — tolta resta barrata, per
  poterla rimettere e perché l'export deve sapere che il motore l'aveva vista — e le
  righe mancanti si aggiungono in fondo, scrivendole o, col cursore su «Nuova riga»,
  selezionandole sul documento: ogni selezione è una riga.

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
che si seleziona sulla pagina ci finisce dentro come correzione. Si può selezionare il
testo, oppure evidenziare un'area — il gesto più rapido, e quello che in revisione si usa
di più.

Un'area su una pagina che il testo ce l'ha si legge **dal text layer**, carattere per
carattere: dentro c'è chi ha il centro dentro il riquadro, così il valore è quello esatto
del documento anche quando pdf.js tiene una riga intera in un solo span. Solo dove testo
non ce n'è — le scansioni — il riquadro viene rasterizzato a scala 3 e letto dallo stesso
worker tesseract della precompilazione. Rileggere con l'OCR un testo che c'è già
introdurrebbe uno scarto da quello su cui lavora il motore, e sarebbe poi quello scarto a
far perdere la posizione della selezione. Il PDF in cache non viene mai toccato: resta
identico byte per byte a quello su Drive.

**Da dove viene un valore selezionato.** Insieme al valore il renderer manda il punto da
cui è stato preso: pagina, riquadro in coordinate di pagina e modo (`TEXT_SELECTION`,
`AREA_TEXT` o `AREA_OCR`; nei DOCX solo la pagina). Il main ne fa un'evidenza del revisore
collegata alla correzione (`corrected_evidence_id`, accanto all'`evidence_id` della proposta del
motore) e la ritrova fra le righe che l'elaborazione ha salvato in `document_pages`: righe
toccate e offset nel testo della pagina, cioè le righe unite da `\n`
(`src/shared/pick-locate.ts`). Sono le righe del motore di estrazione e non quelle del
text layer, perché è su queste che una regola imparata dalla selezione verrà applicata.
Quando il testo compare più volte e il riquadro non basta a distinguerlo, restano le righe
senza offset: una posizione indovinata insegnerebbe un'etichetta sbagliata.

La selezione vale finché è il valore del campo. Riscritto a mano, riportato alla proposta
o tolto, il valore non viene più da lì e l'evidenza sparisce; una rielaborazione la
conserva insieme alla correzione. Nel PDF le selezioni del revisore si vedono con un
riquadro tratteggiato, distinto da quello del motore, e il link sotto il campo porta lì.

**Ripulire una lettura non è riscrivere.** Su una scansione l'OCR legge male — `29 O7 2026`
per `29 07 2026`, `FRAITA (MAB)` per `FRAITA (MAR)` — e il revisore sistema la parola. Il
campo si porta dietro la selezione che aveva (`pickOfEvidence`), e il main la tiene: il
punto del documento è sempre quello, cambia come si legge. L'evidenza allora porta
`textCorrected`, il suo `text` resta la lettura dell'OCR e il valore buono sta sul campo.

L'eccezione vale **solo** per un'area passata dall'OCR, dove il testo l'ha letto una
macchina, e solo se il valore è quella lettura sistemata e non un'altra: oltre un quarto di
caratteri cambiati è un valore diverso (`src/shared/pick-cleanup.ts`). Il testo di una
selezione, e quello di un'area letta dal text layer, vengono dal documento: lì un valore che
non coincide carattere per carattere è un valore diverso, e la selezione non ne è più
l'origine. La posizione si cerca prima col testo letto e, se da lì non escono gli offset,
col valore sistemato: senza offset non si risale all'etichetta, ed è l'etichetta che serve
al learner.

---

## Export del dataset annotato

Gli stessi documenti chiusi dal revisore escono in due forme: **JSON** per il benchmark,
**XLSX** per chi i dati li lavora in foglio. Sono due export paralleli sugli stessi dati —
il formato JSON non cambia perché esiste anche quello Excel. «Esporta», nella dashboard,
apre un menu con le due voci: sono lo stesso export e cambia solo la forma del file,
mentre due pulsanti affiancati facevano sembrare che fossero due cose diverse.

La terza voce, **Dataset completo con i documenti**, mette tutte e due in una cartella
insieme a una copia dei file revisionati: è quella da consegnare, perché il dataset da solo
rimanda a documenti che restano su questa macchina. Come è fatta sta [più
sotto](#dataset-completo-coi-documenti).

Sotto una riga di separazione c'è l'ultima voce, **Mappa dei campi da estrarre**, che non esporta i
documenti annotati ma le correzioni alla mappa «tipo ↔ dati da estrarre»: è l'unico modo in
cui quelle decisioni diventano file. Come è fatta sta [più sotto](#export-della-mappa).

### JSON

La voce «JSON» salva in un file i documenti chiusi dal revisore. È l'input del benchmark
di pratica-ai; l'allineamento col benchmark si fa quando il dataset è pronto, quindi il
formato resta semplice e versionato (`formatVersion`, in `src/shared/dataset.ts`).

```jsonc
{
  "manifest": {
    "format": "praticaai-reviewer/annotated-dataset",
    "formatVersion": "1.9.0",
    "exportedAt": "2026-09-16T18:00:00.000Z",
    "app": { "name": "praticaai-reviewer", "version": "1.1.0" },
    // motori e versioni dell'app al momento dell'export
    "engines": { "classifier": "v2", "extraction": "v2", "classifierVersion": "2.0.0-draft.1",
                 "extractionEngineVersion": "extraction-brain-v2/2.1.0-draft.1", "schemaVersion": "2.0.0" },
    "counts": { "documents": 3, "reviewed": 2, "discarded": 1, "corrections": 7 },
    // con quale apprendimento locale lavorava il motore: l'impronta è delle regole attive
    "learning": { "mode": "LEARNING", "learnerVersion": "local-learner/0.1.0",
                  "activeRules": 2, "rulesFingerprint": "9c1f0a7d54b2e318" }
  },
  "documents": [{
    "driveFileId": "…",               // chiave stabile: https://drive.google.com/file/d/<id>/view
    "contentSha256": "…",             // sha-256 del file elaborato, null se elaborato prima della 1.1.0
    "filename": "…", "mime": "…", "textSource": "NATIVE_TEXT",
    "status": "REVIEWED",             // o DISCARDED
    "reviewedAt": "…",
    "documentType": {
      "id": "accounting.fattura", "label": "fattura",
      // gli stessi tipi come li chiama pratica-ai: vedi «I nomi dei tipi»
      "registry": { "id": "accounting.fattura", "proposed": "accounting.fattura" },
      "chosenBy": "ENGINE",           // REVIEWER se scelto a mano
      "proposed": "accounting.fattura", "proposedConfidence": 0.8267,
      "corrected": false,             // il revisore ha scelto un tipo diverso dalla proposta
      // che cosa ha deciso il classificatore, e contro quali soglie
      "decision": "ASSIGN",           // o UNKNOWN
      "reason": "OK",                 // BELOW_THRESHOLD | LOW_MARGIN | FILENAME_ONLY | HARD_NEGATIVE | NO_SIGNAL
      "margin": 0.31, "threshold": 0.74, "minimumMargin": 0.08,
      // i candidati col punteggio, anche quando non ha assegnato
      "candidates": [{ "documentType": "accounting.fattura", "registryId": "accounting.fattura",
                       "score": 0.8267, "rank": 1 }],
      // dov'era il tipo scelto dal revisore, fra quei candidati
      "chosen": { "rank": 1, "score": 0.8267 }
    },
    // emesso o ricevuto per l'azienda di cui sono i documenti; assente sui tipi che non ne hanno
    "direction": { "value": "EMESSO", "computed": "EMESSO", "matchedBy": "FISCAL_ID",
                   "chosenBy": "ENGINE", "choice": null },
    "extraction": { "engineVersion": "…", "schemaVersion": "2.0.0", "status": "COMPLETED", "completedAt": "…" },
    "fields": [
      { "name": "document.number", "label": "Numero documento", "role": "required", "cardinality": "one",
        "value": "27/2026/B", "origin": "REVIEWER",
        "evidence": { "page": 1, "text": "FATTURA n. 27/2026 del 14/09/2026", "bbox": { "x": 56, "y": 91, "w": 181.6, "h": 11 } },
        "pick": null },
      { "name": "document.issue_date", "label": "Data emissione", "role": "core", "cardinality": "one",
        "value": "14/09/2026", "origin": "REVIEWER",
        "evidence": { "page": 1, "text": "FATTURA n. 27/2026 del 14/09/2026", "bbox": { … } },
        // selezionato sul documento: righe e offset nel testo della pagina salvato dall'elaborazione
        "pick": { "method": "TEXT_SELECTION", "page": 1, "text": "14/09/2026",
                  "bbox": { "x": 182.6, "y": 91, "w": 55, "h": 11 },
                  "location": { "lineStart": 1, "lineEnd": 1, "charStart": 47, "charEnd": 57 } } },
      { "name": "hse.training_expiry", "label": "Scadenza formazione", "role": "core", "cardinality": "one",
        // dedotta dalla normativa, non letta: il documento non la scrive, quindi niente evidenza
        "value": "2026-05-13", "origin": "COMPUTED", "evidence": null, "pick": null },
      { "name": "line_items", "label": "Righe documento", "role": "core", "cardinality": "many",
        "value": ["Demolizione tramezzi - EUR 3.200,00", "…"],
        "origin": "MIXED",            // ENGINE | REVIEWER | MIXED, null se la lista è vuota
        "items": [{ "value": "Demolizione tramezzi - EUR 3.200,00", "origin": "ENGINE", "evidence": { … }, "pick": null }] }
    ],
    "corrections": [
      { "field": "document.number", "label": "Numero documento", "item": null,
        "kind": "CHANGED", "before": "27/2026", "after": "27/2026/B", "pick": null },
      { "field": "line_items", "label": "Righe documento", "item": 2,
        "kind": "REMOVED", "before": "Tinteggiatura pareti - EUR 1.450,00", "after": null, "pick": null }
    ]
  }]
}
```

- Entrano solo i documenti `REVIEWED` e `DISCARDED`, in ordine di nome file. Degli
  scartati restano stato e tipo, con `fields` e `corrections` vuoti: nessuno ne ha
  confermato i valori.
- `value` è il valore confermato: la correzione del revisore dove c'è, altrimenti la
  proposta del motore, `null` se il campo è vuoto. `origin` dice da chi viene: `ENGINE`
  se il motore l'ha **letto** dal documento, `REVIEWER` se l'ha scritto il revisore,
  `COMPUTED` (dalla `1.8.0`) se il motore l'ha **dedotto** — oggi solo la scadenza di un
  attestato di formazione, calcolata dalla normativa perché l'attestato non la scrive
  (`src/shared/training-expiry.ts`). Un valore dedotto non ha `evidence`, e contarlo come
  una lettura riuscita gonfierebbe la misura dell'estrazione; corretto dal revisore torna
  `REVIEWER` come ogni altro. I campi
  ripetuti hanno in `value` la lista dei valori e in `items` gli stessi con provenienza
  ed evidenza; le righe tolte non ci sono. Anche loro hanno `origin`, che vale per la lista
  intera: `MIXED` quando il revisore ha aggiunto righe alle proposte del motore, `null`
  quando la lista è vuota. Serve a contarli come si contano i campi singoli — prima
  `origin` mancava solo qui, e chi leggeva `field.origin` per contare le origini si trovava
  `undefined` invece di un errore.
- `evidence` è la riga da cui il motore aveva letto la proposta, con `bbox` in unità di
  pagina pdf.js a scala 1 (origine in alto a sinistra) o `null` senza coordinate.
- `pick` è il punto da cui il revisore ha preso il valore, sui campi e sulle correzioni:
  `null` se l'ha scritto a mano o non l'ha toccato. `text` è verbatim, `bbox` come per
  `evidence`, `location` le righe toccate e gli offset `[charStart, charEnd)` nel testo
  della pagina come l'ha letto l'elaborazione (righe unite da `\n`); gli offset sono `null`
  quando il testo non si ritrova con certezza, `location` intera quando mancano le righe.
  `textCorrected: true` dice che `text` è una lettura dell'OCR che il revisore ha sistemato
  a mano: il valore buono è quello del campo, e chi misura l'OCR ha lì le due versioni.
- `direction` dice se il documento è **emesso o ricevuto** dall'azienda di cui sono i
  documenti, dalla `1.9.0`. È `null` sui tipi che una direzione non ce l'hanno (una visura
  non è né l'una né l'altra); sugli altri c'è sempre, anche vuota, perché «non si è
  ricavata» è un esito da contare. `computed` è quello che ha detto il calcolo e `value`
  quello che resta: `chosenBy: "REVIEWER"` vuol dire che il revisore ha deciso diversamente,
  e `choice: "NESSUNA"` che ha guardato e non è né l'una né l'altra. `matchedBy` dice su
  cosa ha deciso il calcolo: `FISCAL_ID` o `NAME`. Vedi «[Emesso o
  ricevuto](#emesso-o-ricevuto)».
- `contentSha256` identifica i byte del file indipendentemente da Drive: è la chiave su
  cui pratica-ai indicizza il feedback.
- `registry` porta gli stessi due tipi come li chiama pratica-ai: uguali a `id` e
  `proposed` tranne per le tre classi con slug diverso (vedi «I nomi dei tipi»).
- `decision`, `reason`, `margin`, `threshold`, `minimumMargin`, `candidates` e `chosen`
  dicono che cosa ha deciso il classificatore **anche quando non ha assegnato**, dove
  `proposed` è `null` e basta. `candidates` sono i tipi col punteggio, in ordine; `chosen`
  è dove fra quelli è finito il tipo che il revisore ha poi scelto. `chosen.rank: 1` con
  `decision: "UNKNOWN"` vuol dire che il classificatore ci aveva preso e si è fermato per
  una soglia; `chosen.rank: null` che il tipo giusto non era in lista, e abbassare le
  soglie non lo farebbe comparire. Le frasi che sostengono i candidati restano fuori:
  servono a chi revisiona, e sono verbatim del documento. `null` dappertutto per un
  documento che il classificatore non ha mai visto.
- `learning` dice in che modalità era il learner e quali regole valevano: due export con la
  stessa `rulesFingerprint` sono stati precompilati dalle stesse regole, ed è quello che un
  benchmark deve dichiarare accanto ai suoi numeri. Dalla `1.0.0` alla `1.9.0` si aggiungono
  solo campi, e due valori: `AREA_TEXT` a `pick.method`, l'area letta dal text layer, e
  `COMPUTED` a `origin`, il valore dedotto.

### I nomi dei tipi

Il reviewer parla la lingua del registry (`resources/registry`), pratica-ai quella del suo
`document-registry` V5.1. Sulle classi coincidono, **meno tre**: classi che i due progetti
hanno aggiunto per conto proprio, con lo stesso nome canonico e uno slug diverso. Dopo il
Brain MVP quelle tre sono fuori dalle 171 canoniche, ma la traduzione resta: i documenti
già chiusi su di loro escono comunque negli export.

| Qui | In pratica-ai | |
|---|---|---|
| `contracts_general.contratto_raggruppamento_temporaneo_imprese` | `contracts_general.rti` | contratto RTI |
| `hse_risk.autocertificazione_idoneita_tecnico_professionale` | `hse_risk.idoneita_autocertificazione` | autocertificazione idoneità tecnico-professionale |
| `payroll_contributions.dichiarazione_regolarita_retributiva` | `payroll_contributions.regolarita_retributiva` | dichiarazione regolarità retributiva |

Nessuno dei due registry si tocca — sono snapshot, e la regola è la stessa di là: non si
modificano, si somma qualcosa in lettura — quindi la traduzione sta in
`src/shared/registry-alignment.ts` e si applica alle frontiere. Negli export (dataset e
regole apprese) ogni tipo esce anche con lo slug di pratica-ai; assegnando un tipo a mano,
uno slug copiato da pratica-ai vale come il suo, o resterebbe un tipo senza profilo. Dentro
l'app e nel database gli id restano quelli del pack, che è chi fornisce i profili.

Non sono un disallineamento le classi che esistono da un lato solo: qui
`certifications_licenses.ricevuta_presentazione_suap` e
`governance_compliance.questionario_adeguata_verifica_cliente_aml`, di là `fiscal_tax.durf`,
`finance_corporate.piano_finanziario` e `payroll_contributions.rateazione_inps`. Sono
vocabolari a versioni diverse, e si allineano quando uno dei due pacchetti si aggiorna. La
mappa dei campi da estrarre invece esce con gli id del pack, perché è il pack a consumarla.
- `corrections` è la misura di quanto aiuta la precompilazione: una voce per campo
  toccato, una per riga nei ripetuti. `kind` vale `CHANGED` (proposta diversa),
  `FILLED` (il motore non aveva proposto niente), `CLEARED` (proposta svuotata), `ADDED`
  e `REMOVED` (righe). `before` è la proposta dell'ultima estrazione, `after` il valore
  del revisore; `item` è l'indice della riga nella tabella di revisione.
- Una nuova estrazione dello stesso documento non tocca il lavoro del revisore, quindi
  before/after restano validi anche dopo un re-run. Se il motore ora propone proprio il
  valore corretto a mano, quella non è più una correzione.

Il test `tests/dataset-export.test.ts` elabora le fixture con la pipeline v2, le corregge,
le rielabora, le chiude e confronta il file con `tests/fixtures/dataset-export.expected.json`.

### XLSX

La voce «Excel» salva gli stessi documenti come foglio di calcolo: due tabelle legate da
`document_id`, invece di un JSON annidato. Le righe le costruisce `buildXlsxRows` in
`src/shared/dataset-xlsx.ts` — funzione pura, senza database né exceljs — e il file lo
scrive `src/main/xlsx-export.ts`.

Il foglio **`documents`**, una riga per documento chiuso:

| Colonna | Cosa contiene |
|---|---|
| `document_id` | id locale del documento, chiave verso il foglio `fields` |
| `drive_file_id` | id del file su Drive: `https://drive.google.com/file/d/<id>/view` |
| `document_type_predicted` | il tipo assegnato dal classificatore; vuoto se `UNKNOWN` o scelto a mano |
| `document_type_final` | il tipo che resta, cioè la verità del revisore |
| `classifier_confidence` | punteggio del classificatore sul tipo proposto |
| `runner_up` | secondo candidato del classificatore v2 |
| `margin` | distacco fra primo e secondo candidato |
| `template_fingerprint` | impronta del layout della prima pagina |
| `review_status` | `REVIEWED` o `DISCARDED` |
| `direction` | `EMESSO` o `RICEVUTO`; vuota sui tipi senza direzione e dove non si è ricavata |
| `direction_chosen_by` | `ENGINE` se viene dal calcolo, `REVIEWER` se l'ha scelta il revisore |
| `review_note` | la nota del revisore, se l'ha scritta |

Il foglio **`fields`**, una riga per campo — e una riga per ogni riga dei campi ripetuti,
che `item_index` ordina: `document_id`, `field_name`, `label`, `role`, `cardinality`,
`item_index` (vuoto sui campi singoli), `value_predicted` (la proposta del motore),
`value_final` (il valore confermato), `origin` (`ENGINE` o `REVIEWER`), `confidence`,
`evidence_page`, `evidence_text` (verbatim) ed `evidence_bbox` (JSON del riquadro).

- `runner_up` e `margin` restano vuoti sui documenti classificati col motore v1, che non
  li calcola: non si inventano. Vengono dall'audit dell'**ultimo** run del documento,
  che è quello che corrisponde ai campi di adesso.
- Degli scartati resta la riga in `documents` col loro stato, senza campi: nessuno ne ha
  confermato i valori, come nell'export JSON. Su di loro `review_note` è l'unica cosa che
  dice **perché** il documento è fuori dal dataset.
- `review_note` è la nota facoltativa scritta chiudendo il documento. Sta sulla colonna
  `documents.review_note` (migrazione `0007`): prima finiva solo dentro il testo della
  riga di timeline, che si legge a occhio e non è un formato. Si sovrascrive a ogni
  decisione, anche quando è vuota — richiudere un documento senza scrivere niente vuol
  dire che la nota di prima non vale più — e i documenti chiusi prima di questa versione
  escono con la cella vuota. Nell'export JSON non c'è: cambiare il formato del benchmark
  per un campo di testo libero non vale il `formatVersion` che costerebbe.
- A differenza del JSON, le righe **tolte** dal revisore ci sono, con `value_final`
  vuoto: quello che il motore aveva proposto è una misura e non si perde, esattamente
  come per un campo singolo svuotato.
- Un re-run dell'estrazione non duplica righe né perde correzioni: i due fogli si
  ricostruiscono ogni volta dallo stato corrente del documento.

`template_fingerprint` è l'impronta del **layout** della prima pagina, e serve a
riconoscere i documenti usciti dallo stesso stampato: si collassano gli spazi, ogni
sequenza di lettere diventa `A` e ogni sequenza di cifre `9`, la riga si tronca a 120
caratteri e la lista di righe si riassume nei primi 16 caratteri di uno SHA-256
(`src/shared/template-fingerprint.ts`). Stesso stampato con dati diversi, stessa
impronta. La calcola l'elaborazione, dalle stesse righe che salva, e resta sulla colonna
`documents.template_fingerprint` (migrazione `0006`). Fanno eccezione i documenti
elaborati prima della migrazione `0010` e quelli con la prima pagina letta con OCR: per
loro l'impronta si ricava dalla copia in cache al primo export che ne ha bisogno. Un
documento così, la cui copia locale non c'è più, esce con l'impronta vuota: per un export
non si riscarica niente da Drive.

Il test `tests/xlsx-export.test.ts` scrive il file dalle fixture e lo rilegge con
exceljs: intestazioni, conteggi, impronte e valori confermati.

### Dataset completo, coi documenti

I due export di sopra descrivono documenti che chi li riceve non ha: le evidenze sono
pagine, righe e riquadri di file che stanno nella cache di questa macchina, e senza quei
file un valore non si controlla e un motore non ci si fa girare sopra. La voce **Dataset
completo con i documenti** chiede una cartella e ci scrive tutto insieme:

```
praticaai-dataset-2026-09-25/
├── dataset.json        # identico all'export JSON, byte per byte
├── dataset.xlsx        # identico all'export Excel
├── documenti.json      # quale file è quale riga del dataset
└── documenti/
    ├── Fattura 114.pdf
    └── DURC 1_2026.pdf
```

I due file di dati non sono una seconda versione del formato: sono gli stessi che
escono dalle voci «JSON» ed «Excel», scritti dallo stesso codice
(`src/main/dataset-bundle.ts`), e il test lo confronta byte per byte. Quello che si
aggiunge è la cartella `documenti/` e il file che la lega al dataset.

I nomi dei file copiati sono quelli che il revisore vede in Drive, ripuliti di quello che
un filesystem rifiuta (`/ \ : * ? " < > |` e i caratteri di controllo) e con l'estensione
del mime, perché quella cartella la apre una persona. Due documenti che su Drive si
chiamano allo stesso modo — «fattura.pdf» ce n'è in ogni cartella — non si sovrascrivono:
il secondo prende un `-2`. L'ordine è quello del dataset (nome file, poi id di Drive), così
due export dello stesso database danno gli stessi nomi.

`documenti.json` è il legame fra le due cose, ed è la parte che conta:

```jsonc
{
  "format": "praticaai-reviewer/annotated-dataset-files",
  "formatVersion": "1.0.0",
  "exportedAt": "2026-09-25T18:00:00.000Z",
  "counts": { "documents": 3, "copied": 2, "missing": 1, "mismatched": 0, "bytes": 3512044 },
  "files": [
    { "driveFileId": "…",              // la stessa chiave del dataset
      "filename": "Fattura 114.pdf", "mime": "application/pdf", "status": "REVIEWED",
      "file": "documenti/Fattura 114.pdf",
      "bytes": 184320,
      "sha256": "…",                   // della copia, ricalcolato dopo averla scritta
      "contentSha256": "…",            // del file su cui il revisore ha annotato
      "matchesAnnotated": true,
      "missing": null },
    { "driveFileId": "…", "filename": "Visura 2026.pdf", "mime": "application/pdf",
      "status": "REVIEWED", "file": null, "bytes": null, "sha256": null,
      "contentSha256": "…", "matchesAnnotated": null,
      "missing": "NO_LOCAL_COPY" }     // o FILE_GONE, COPY_FAILED
  ]
}
```

- Entrano **tutti** i documenti del dataset, scartati compresi: «questo non vale» è
  un'annotazione come le altre, e chi misura vuole vedere su cosa è stata presa.
- Ogni copia viene riletta per il suo `sha256` e confrontata col `contentSha256` registrato
  quando il documento è stato elaborato. Se non coincidono, il file su Drive è cambiato
  dopo la revisione e **i valori annotati non sono di quel file**: `matchesAnnotated: false`,
  il documento esce lo stesso e il conto `mismatched` lo dice anche nella riga di stato. Un
  documento elaborato prima della `1.1.0` non ha un `contentSha256` da confrontare e resta
  `null`, che non è la stessa cosa di `false`.
- Un file che manca non è un documento in meno: la riga nel dataset resta e il manifest
  scrive perché non c'è. `NO_LOCAL_COPY` è la copia tolta dalla cache con «Libera spazio»,
  `FILE_GONE` il path registrato ma il file sparito dal disco. Anche qui l'export **non
  riscarica niente da Drive** — vale la regola dell'XLSX, e per lo stesso motivo: un export
  non deve dipendere dal fatto che Drive risponda. I mancanti si contano nella riga di
  stato, con cosa fare («riaprili da Drive e riesporta»).

La forma dei nomi e del manifest sta in `src/shared/dataset-bundle.ts`, modulo puro senza
filesystem; copie e sha li fa `src/main/dataset-bundle.ts`. I test sono
`tests/shared-dataset-bundle.test.ts` per i nomi e i conti, e `tests/dataset-bundle.test.ts`
che esporta davvero una cartella dalle fixture e la rilegge, compresi i tre casi che
contano: il file che manca, il file sparito dal disco e la copia che non è più il documento
annotato.

---

## Emesso o ricevuto

La stessa fattura è **emessa** per chi la scrive e **ricevuta** per chi la paga: la
direzione non è un dato del documento, dipende da chi guarda. Per questo non è un campo
estratto — non ha un'etichetta da cercare né un'evidenza verbatim — ma un attributo del
documento, che si ricava confrontando emittente e destinatario con **l'azienda di cui sono
i documenti**.

Quell'azienda è l'unica impostazione dell'app: ragione sociale, partita IVA e codice
fiscale, nella dashboard, sotto «L'azienda di cui sono i documenti» (tabella
`company_identity`, migrazione `0019`). Finché è vuota nessun documento ha una direzione,
ed è giusto: non c'è niente con cui confrontare le parti.

Il conto sta in `src/shared/document-direction.ts`, modulo puro, e si rifà **a ogni
lettura**: non è salvato da nessuna parte, così cambiare l'impostazione non lascia in giro
direzioni vecchie, e mentre il revisore compila i campi la direzione si aggiorna da sola.
Le regole, in ordine:

1. **Partita IVA e codice fiscale** dell'emittente contro quelli dell'azienda: se
   combaciano è `EMESSO`; col destinatario, `RICEVUTO`. I profili portano chiavi diverse a
   seconda del tipo (`*.vat_number` e `*.tax_code` sulla fattura, `*.tax_id` sulla
   proforma e sulla nota di credito), e un `tax_id` può essere l'uno o l'altro: si
   confronta con tutti e due.
2. **Il nome**, solo se gli identificativi non hanno deciso. Il preventivo non ha nessun
   campo fiscale in profilo: senza il nome resterebbe sempre vuoto. Il confronto ignora
   maiuscole, punteggiatura e forma societaria.
3. Se non decide nessuno dei due, **o se l'azienda è da tutte e due le parti**, la
   direzione resta vuota. È anche la risposta al conflitto che la separazione di partita
   IVA e codice fiscale si porta dietro: una «P.IVA» che l'etichetta non attribuisce
   finisce su emittente **e** destinatario con lo stesso valore, e lì non c'è niente da
   decidere. Un campo segnato in conflitto vale comunque come ogni altro — scartarli tutti
   avrebbe bloccato anche i documenti in cui il revisore ne ha accettato uno comʼera.

I tipi con una direzione sono quattro: `accounting.fattura`, `accounting.fattura_proforma`,
`accounting.nota_di_credito` e `procurement.preventivo`. Su una visura o su una carta
d'identità la domanda non ha senso, e una riga vuota in più su 500 tipi sarebbe rumore.

**Il revisore può correggerla**, dalla scheda «Dati», accanto al tipo: `Emesso`,
`Ricevuto` o `Né l'uno né l'altro`. La sua scelta vince sempre e non si ricalcola (colonna
`documents.direction_choice`); «Torna al calcolo» la toglie. Nel dataset escono tutti e due
— quello che il calcolo aveva detto e quello che resta — perché è la differenza fra i due a
dire se il calcolo funziona, come per il tipo del classificatore.

**Perché non due tipi `fattura_emessa` e `fattura_ricevuta`:** la tassonomia è del pack, e
la direzione dipende da chi guarda, non dal documento. Due tipi raddoppierebbero
classificatore e profili per un dato che si calcola.

## Campi da estrarre

Quali dati vanno estratti da ogni tipo documento è scritto in
`resources/registry/document_fields.json`, e sono per lo più bozze: **135 mappe su 171
sono `SCHEMA_READY` o proposte, scritte a tavolino e mai verificate su documenti veri**, e
da lì nascono difetti come il «numero» chiesto a tipi che non lo prevedono. La mappa si corregge **dentro la revisione**, dalla scheda «Campi da estrarre»
accanto a «Dati»: il revisore che sta compilando un documento e vede un campo che manca o
che non serve lo sistema lì, il documento si rielabora con la mappa nuova, e torna a «Dati»
per finire il lavoro. Non c'è più una schermata a parte: costringeva a salvare un documento
coi campi sbagliati, cambiare pagina, correggere e tornare a rifare la revisione.

Il confine è quello di sempre: qui si misura **l'utilità della precompilazione**, cioè
delle regole fisse offline. L'IA di pratica-ai si valida col dataset esportato, sul
benchmark della monorepo: altro lavoro, altro posto. Ed è l'ordine che conta — prima si
sistema la mappa, poi le annotazioni valgono come metro.

**Le tre misure**, per campo, accanto a ogni campo della scheda. Si calcolano sui soli
documenti `REVIEWED` di quel tipo — i `DISCARDED` non votano, e nemmeno quelli ancora in
coda. Su un tipo mai revisionato i numeri sono zero, ma i campi ci sono lo stesso: la mappa
si corregge anche sul primo documento.

| Misura | Cosa vuol dire |
|---|---|
| **confermato** | il motore ha proposto un valore e il revisore non l'ha toccato |
| **corretto** | il motore ha proposto un valore e il revisore ne ha messo un altro (o l'ha svuotato) |
| **a mano** | il campo era vuoto e il revisore l'ha riempito: il motore lo chiede ma non lo trova |
| **mai usato** | la mappa lo chiede, ma su tutti i documenti annotati di quel tipo non ha mai avuto un valore — candidato allo scarto |
| **assente dalla mappa** | il revisore lo compila sui documenti di quel tipo e la mappa non lo prevede — candidato all'aggiunta |
| **segnato non utile** | il revisore l'ha scartato per questo tipo: resta in elenco, con i numeri che aveva |

Per il singolo campo il denominatore è il numero di documenti annotati del tipo. Per il
tipo sono i campi che hanno finito per avere un valore (`confermati + corretti + a mano`):
un campo vuoto da entrambe le parti non dice niente sull'utilità della precompilazione, e
conta invece come «mai usato». Le regole di cosa sia una correzione sono le stesse della
revisione (`@shared/field-edits`): riscrivere il valore proposto non è una correzione.

### Le correzioni stanno nel database, non nei JSON

**I JSON del registry non vengono mai scritti.** Sono la base — quella del programmer
pack — e restano identici. Quello che il revisore decide è una riga su
`profile_overrides` (migrazione `0008`): per ogni coppia tipo/campo, un peso oppure
**«non utile»**. Il registry applica queste decisioni a ogni lettura
(`@shared/profile-overlay`), quindi una correzione vale **subito** — sul prossimo
documento elaborato — senza riscrivere niente sul disco e senza rileggere il registry.

È un cambiamento rispetto alle versioni fino alla 1.3: prima ogni correzione riscriveva i
JSON del repo e ne faceva un commit git. Quel meccanismo funzionava solo in sviluppo —
l'app impacchettata legge il registry da `process.resourcesPath`, di sola lettura, e lì la
correzione diventava un file da sostituire a mano — e legava il lavoro del revisore a un
repository che sulla sua macchina non c'è. Adesso il lavoro sta accanto alle annotazioni
che lo motivano, nello stesso database, e diventa un file solo quando lo si esporta.

**Uno o più valori.** Ogni campo dell'ontologia ha una cardinalità di partenza
(`default_cardinality`): 36 campi su 257 chiedono più valori (righe, parti, garanzie…),
gli altri uno solo. Lo stesso dato può però averne uno su un tipo e più d'uno su un altro,
e il revisore lo decide tipo per tipo: la decisione è una riga su
`profile_cardinality_overrides` (migrazione `0009`), separata dal peso, e c'è solo quando
è diversa dall'ontologia — rimettere la cardinalità di partenza toglie la riga. Il registry
la scrive sul profilo in `field_cardinality`, il motore la legge da lì prima
dell'ontologia, e l'export la porta così com'è nel profilo, come `array` negli schemi e
nel changelog. Quando il documento si rielabora, **quello che il revisore aveva scritto non
si perde**: passando a più valori la correzione del campo finisce sulla riga che il motore
ripropone (o diventa una riga del revisore), passando a un valore solo le righe rimaste
diventano la correzione del campo, unite con `; ` se sono più d'una.

**«Non utile» è uno stato, non una cancellazione.** Il campo esce dalla mappa che il
motore usa, ma resta in elenco nella sua sezione, con i numeri che aveva e il pulsante per
rimetterlo. Nell'export finisce in `x_reviewer_excluded_fields` sul profilo: chi legge il
file sa che quel campo è stato guardato e scartato, non semplicemente dimenticato.

### La scheda

Ogni campo della mappa è una scheda — la colonna è stretta, come per i campi di «Dati» —
con il peso (obbligatorio, principale, opzionale, condizionale), i **valori da estrarre**
(un solo valore o più valori), i numeri in una riga e le azioni sotto: **Aggiungi etichetta** insegna al motore l'etichetta con cui il campo compare
nei documenti veri, **Segna non utile** lo toglie dalla mappa, **Ripristina** toglie la
decisione del revisore e rimette quello che dice il registry. Sotto la mappa: i campi che
il revisore compila a mano e la mappa non prevede, da aggiungere col peso scelto; quelli
segnati non utili, con il modo di rimetterli; e **l'ontologia intera**, tutti i 257 campi,
perché una mappa sbagliata si vede anche per assenza. Un id che l'ontologia non conosce
viene rifiutato al confine IPC: nessun motore saprebbe cercarlo. In fondo, le **modifiche a
questo tipo** ancora annullabili, ognuna col suo «Annulla».

**Cosa si rielabora.** Una correzione rielabora **subito il documento aperto**, dalla cache:
la scheda «Dati» riceve i campi della mappa nuova, con le correzioni già fatte (la pipeline
le tiene per nome del campo). Gli **altri documenti in coda dello stesso tipo** si
rielaborano in sottofondo, uno alla volta, così il prossimo che si apre ha già i campi
giusti. I documenti salvati o scartati non si toccano: il loro tipo e i loro campi sono il
dato consegnato. Senza copia locale la correzione vale lo stesso, ma il documento resta
quello di prima finché non lo si riapre da Drive, e il messaggio lo dice.

**Le due cornici restano marcate.** I 15 profili con `EXTRACTION_SCHEMA_READY_FOR_FIELD_TEST`,
costruiti su documenti reali, hanno il badge «Verificato» e una loro modifica chiede una
conferma, dentro la scheda del campo dove si è appena cliccato. I tipi senza profilo
esplicito (`LEGACY_FALLBACK`) appaiono come tali: si correggono allo stesso modo, e
nell'export il loro profilo viene materializzato con `schema_state`
`EXTRACTION_SCHEMA_DRAFT_FROM_LEGACY_FALLBACK`, perché resti visibile che non è uno schema
verificato.

La scheda non esporta niente: la mappa si esporta da «Esporta» nella dashboard, insieme al
dataset.

### Cronologia

La terza voce della navbar tiene **ogni azione**, in una lista sola: correzioni alla
mappa, annullamenti ed export da una parte; aperture, cambi di tipo, salvataggi e
scarti dei documenti dall'altra. Si filtra per sorgente e si cerca a testo. Ogni riga dice
cosa è successo e con quali numeri.

Da qui — o dalla scheda «Campi da estrarre», per le correzioni al tipo del documento
aperto — si **annulla** una correzione. L'annullamento rimette esattamente la riga che c'era
prima — `previous_override`, che non sempre coincide con il ruolo precedente: un campo può
essere «principale» perché lo dice il registry, e annullare non deve lasciare una decisione
che nessuno ha preso — e diventa a sua volta una riga. **La cronologia non si riscrive**:
l'azione annullata resta, marcata. Si annulla solo l'ultima decisione presa su un campo,
controllato nel main e non solo nella UI: annullarne una più vecchia rimetterebbe uno stato
che nel frattempo è cambiato, e la mappa direbbe una cosa mentre la cronologia ne dice
un'altra. Il peso e il numero di valori sono due decisioni distinte, e ognuna segue la sua
fila: cambiare il peso di un campo non blocca l'annullamento della sua cardinalità.

### Export della mappa

«Esporta → **Mappa dei campi da estrarre**», nella dashboard, chiede dove creare la cartella e ci
scrive quattro file (`@shared/profile-bundle`):

| File | Cosa contiene |
|---|---|
| `fields.json` | i campi, con le etichette insegnate in coda agli alias del registry |
| `document_fields.json` | le 171 mappe, con le correzioni applicate: si sostituisce a quella sul disco |
| `extraction_schemas.json` | uno JSON Schema per tipo, con le chiavi dell'ontologia: la forma che l'Extraction Brain di pratica-ai consuma senza traduzioni |
| `changelog.json` | cosa è cambiato rispetto al registry, tipo per tipo, e ogni azione con i numeri che l'hanno motivata — annullate comprese |

I tipi non toccati escono identici a com'erano, e due export di fila danno gli stessi byte.
Il generatore degli schemi è verificato al contrario:
`tests/shared-profile-bundle.test.ts` rigenera gli schemi di tutti e 171 i tipi **senza
nessuna correzione** e controlla che ogni proprietà abbia la forma che l'ontologia dichiara
per quel campo. Se sbaglia una forma (una data che non diventa `format: date`, un campo
`many` che non diventa un array) si vede lì, non mesi dopo dentro pratica-ai.

Il file `extraction_schemas.json` del registry di pratica-ai è ancora quello v1, con i nomi
campo di prima (`document_number`, `issue_date`): la traduzione all'indietro non è
esprimibile per i campi dell'ontologia che un nome v1 non ce l'hanno, e per questo l'export
parla la lingua dell'ontologia e lascia la conversione a chi sa cosa farsene.

**Portabilità.** Le misure (`src/shared/profile-metrics.ts`), le regole di una correzione
(`src/shared/profile-edit.ts`), l'overlay (`src/shared/profile-overlay.ts`) e i file
dell'export (`src/shared/profile-bundle.ts`) sono moduli puri, senza Electron, senza
database e senza UI: destinazione pratica-ai. Il livello che legge dal database
(`src/main/profile-insights.ts`, `src/main/profile-map.ts`) tiene tutte le query in un
posto solo — nella UI non ce n'è nemmeno una. `tests/profile-map.test.ts` fa il giro intero
su documenti veri: annota, misura, corregge dal documento, che si rielabora, annulla ed
esporta.

**Quando cambia la mappa.** Il documento aperto e quelli in coda dello stesso tipo si
rielaborano da soli. I documenti già salvati restano com'erano: la versione dei profili
(`version` nel JSON) non cambia con una correzione, quindi nemmeno la rielaborazione in
sottofondo all'avvio li riprende.

---

## Apprendimento locale

Il reviewer si prepara a imparare dalle revisioni: quale etichetta annuncia un campo, quale
tipo ha un modulo che ricorre. Il piano, la compatibilità con pratica-ai e le decisioni
stanno in [`docs/local-learning-analisi.md`](docs/local-learning-analisi.md). Il learner
registra le revisioni salvate nel suo deposito (migrazioni `0011` e `0012`,
`src/main/db/dao/learning.ts`) e ne ricava due cose che valgono sui documenti successivi:
le etichette con cui un modulo annuncia i suoi campi, e il tipo di un modulo che ritorna.

**Tre modalità**, salvate nel database, ogni cambio in cronologia:

| Modalità | Registra le revisioni | Applica le regole attive |
|---|---|---|
| `LEARNING` (predefinita) | sì | sì |
| `FROZEN` | no | sì |
| `BASELINE` | no | no, solo registry: per benchmark e holdout |

**Cosa si tiene.** Un evento per ogni decisione del revisore — tipo confermato o cambiato,
campo confermato, corretto, compilato, svuotato — con l'autore, lo sha-256 del file e la
posizione della selezione, ma senza valori né testo del documento. Gli eventi non si
aggiornano, non si cancellano e sopravvivono al documento, come `document_type_feedback`
in pratica-ai. Le regole nascono candidate, e diventano attive, sospese o scartate solo
passando dalla cronologia; supporto e precisione si calcolano dai contatori delle prove.

**Quando si registra.** Al salvataggio di una revisione, non a ogni modifica di un campo:
i valori mentre si lavora sono provvisori, il salvataggio è la decisione. Gli eventi
(`src/shared/review-learning.ts`) sono uno per il tipo — confermato, cambiato, scelto dove
il motore non ne aveva, tolto — e uno per ogni campo o riga che il motore aveva proposto o
che il revisore ha toccato; un campo vuoto che nessuno ha toccato non dice niente. Si
scrivono nella stessa transazione che chiude il documento: se la registrazione fallisce,
la revisione non si salva. Uno scarto non insegna niente. L'autore è l'account Google
collegato: senza account la revisione si salva ma non si registra. La riga di timeline
della revisione dice cosa è stato registrato, o perché no.

**La garanzia su `FROZEN` e `BASELINE`** sta nella forma del codice: il learner scrive solo
dentro `learning.acquire(work)`, che esegue il lavoro in una transazione e solo in
`LEARNING`. Nelle altre modalità il lavoro non parte, quindi non esiste una scrittura
dimenticata che possa contaminare una misura.

**Etichette imparate.** Quando il revisore seleziona un valore sul documento, il learner
cerca l'etichetta che lo annuncia (`src/main/learning-anchors.ts`): le ultime parole prima
del valore sulla stessa riga, o la fine della riga sopra se il valore sta in testa. Mai
cifre, al massimo tre parole, e senza scavalcare un'altra etichetta («Emittente:»). Fra le
candidate vince la più corta che, letta con le regole del motore su quella pagina, trova un
valore in un punto solo, e quel punto è la selezione. Una selezione insegna due regole: una
per il template (l'impronta del modulo) e una per il tipo.

**Anche un valore digitato** (`src/main/inferred-pick.ts`). Chi compila un campo a mano,
senza selezionare niente sul documento, non lascia nessuna posizione — e senza posizione non
c'è etichetta, quindi non c'è regola. Ma durante l'annotazione a mano si digita di continuo,
ed era il buco più costoso. Adesso il valore salvato si cerca fra le righe della pagina nelle
forme verbatim in cui poteva starci scritto: una data salvata `2026-09-12` si cerca anche
come «12/09/2026», un importo `1250.00` anche come «1.250,00», un IBAN anche a gruppi di
quattro. Sono riscritture della stessa cifra, mai valori nuovi.

Il punto si accetta **solo se una di quelle forme compare una volta sola in tutto il
documento**, e solo per valori di almeno tre caratteri. «10,00» che è insieme il totale e
l'imponibile non dice dove il revisore stesse guardando, e allora si rinuncia: un campo senza
regola è un costo che si vede subito, un'ancora messa sul punto sbagliato precompila male
tutti i documenti di quel modulo, e lo si scopre dentro il dataset. Nel registro quella
posizione si distingue dalle altre (`EXACT_VALUE_MATCH`), il valore cercato non entra
nell'evento, e dove una selezione c'è già — compresa quella sopravvissuta a una lettura
sistemata — non si prova nemmeno: decide il revisore.

**Quando una regola vale** (`nextRuleStatus`, soglie in `DEFAULT_LEARNING_POLICY`):

| | Si attiva | Si sospende |
|---|---|---|
| Template | 2 documenti dello stesso modulo, nessuna smentita | 2 smentite di fila, o precisione sotto il 70% con almeno 5 prove |
| Tipo | 3 documenti, precisione ≥ 90% | come sopra |

Una regola si mette alla prova sui documenti che ha precompilato: valore confermato, prova a
favore; corretto o svuotato, prova contro — a meno che il revisore non selezioni proprio il
punto che la regola legge, e allora cambia solo la forma. Le prove sono una per documento
(per sha-256): richiudere un documento sostituisce le sue, scartarlo le toglie. Il learner
attiva e sospende da sé, ma non riattiva e non scarta: tornare a fidarsi di una regola
sospesa è una decisione di una persona.

**Nell'estrazione** le etichette delle regole attive del tipo — di tipo, o del template del
documento — passano davanti a quelle del registry, quelle di template davanti a quelle di
tipo; i validatori restano l'ultima parola. L'evidenza del valore dice quale regola l'ha
trovata (`evidence.rule_id`), con che ambito valeva (`rule_scope`) e come il valore è stato
letto (`extraction_strategy`: dopo l'etichetta sulla stessa riga, o sulla riga successiva);
il run registra in `metrics_json.learning` modalità, regole disponibili e regole usate. La
provenienza non si vede in revisione e non decide niente: serve al confronto pre/post, per
sapere quale parte ha prodotto un numero invece del solo totale. Quando una regola si attiva o si sospende, i documenti in coda
del suo tipo si rielaborano in sottofondo, come dopo una correzione della mappa.

**Cos'è «lo stesso modulo»** (`src/shared/template-fingerprint.ts`). L'impronta della `0013`
è una chiave: due documenti la condividono o no. Misurato sull'export del 18/09/2026, quasi
sempre no — ogni impronta valeva per un documento solo, perché basta una riga che va a capo
diversamente o un campo compilato dove l'altro esemplare lo lascia vuoto. Con
`minTemplateSupport` a 2 e `minTemplateTypeSupport` a 3, questo vuol dire che **nessuna
regola di scope template poteva attivarsi**: lo scope più preciso restava candidato per
sempre.

Dalla `0016` accanto all'impronta c'è una **firma normalizzata**: non solo la chiave, ma
l'insieme delle ancore da cui è ricavata, ognuna hashata a parte. Due testate si confrontano
allora per quante ne hanno in comune (Jaccard) invece che per uguaglianza, e sopra
`minTemplateSimilarity` (`0,68`) sono lo stesso modulo: le loro revisioni si sommano sulla
stessa regola. Come l'impronta, la firma non porta fuori né testo né valori — la ragione
sociale e l'indirizzo restano fuori apposta, perché sono il soggetto e non il modulo.
L'impronta esatta resta dov'era: le regole scritte prima della firma continuano a valere per
confronto esatto. La soglia è scelta a occhio sui pochi documenti disponibili e **va ritarata
sul corpus reale**.

**Memoria dei moduli** (`src/main/learning-templates.ts`). Ogni revisione salvata con un
tipo conta per il suo modulo: a favore di quel tipo, contro ogni altro tipo con cui lo stesso
modulo era stato chiuso. Tre revisioni concordi e nessun conflitto attivano la memoria; un
solo conflitto la sospende. È più prudente di un'etichetta perché un tipo sbagliato cambia
tutti i campi che si cercano. Nel classificatore v2 la memoria è un segnale a sé («già
revisionato con questo tipo») che vale esattamente la soglia di assegnazione: da sola basta a
proporre il tipo, ma non passa sopra un hard negative, non vince un margine troppo stretto e
resta fuori dal bonus di corroborazione. Un modulo **riconosciuto per somiglianza** vale in
proporzione alla somiglianza, quindi resta sotto la soglia e da solo non assegna niente: la
testata somiglia, ma non è la stessa. Quando una memoria si attiva o si sospende si
rielaborano i documenti in coda con quell'impronta, qualunque tipo abbiano. Le frasi del
classificatore invece non si imparano: vedi il documento di analisi.

**La scheda «Apprendimento»** (voce di menu in alto, con la modalità sempre accanto) mostra
quello che il motore ha imparato e lo governa:

- la modalità, con cosa fa ognuna delle tre: cambiarla vale dai documenti elaborati da
  quel momento, i documenti già precompilati restano come sono;
- i contatori: decisioni registrate, regole attive, sospese, candidate;
- le regole, prima quelle che stanno cambiando la precompilazione, ognuna con la frase che
  dice cosa ha imparato («Data emissione» sta dopo «data» sul modulo …), i suoi numeri e
  l'ultima prova. I numeri sono due percentuali, non una: la **precisione**, quante volte
  la regola ci ha preso — ed è quella su cui il learner la attiva o la sospende — e
  l'**affidabilità**, la stessa cosa corretta per quante prove ci sono sotto. Due conferme
  senza smentite fanno precisione 100% e affidabilità 75%: vero tutti e due, ma il secondo
  dice che dietro quel 100% ci sono due documenti. Serve a chi decide a mano, e non pesa
  niente nell'estrazione. Da qui una regola si **sospende**, si **riattiva** o si **scarta** —
  scartare chiede un secondo clic, e **si può annullare**: nessun passaggio riapre una
  regola scartata, ma «Annulla ultima modifica» rimette lo stato che c'era prima, e in
  cronologia restano tutte e due le decisioni. Il learner promuove e sospende da sé, ma non
  riattiva: quella è una decisione di una persona;
- la cronologia del learner, dove le decisioni automatiche e quelle a mano stanno insieme.

Quando si sospende o si riattiva una regola, i documenti in coda che ne dipendono si
rielaborano come dopo una promozione.

**L'annullamento è una riga in più, non una riga tolta.** Ripristino dello stato,
marcatura dell'azione annullata e riga nuova stanno in una transazione sola, e la
cronologia non si riscrive mai: si aggiunge un'azione `REVERT` che dice cosa ha annullato.
Il pulsante compare **solo dove c'è davvero qualcosa da annullare**: l'ultimo cambio di
stato dev'essere ancora quello in vigore — se nel frattempo il learner ha sospeso la
regola da sé, non c'è più niente da riportare indietro. E non si annulla una **promozione
del learner**: i contatori che l'hanno fatta scattare restano dove sono, quindi la prima
revisione che conferma la regola la ripromuoverebbe. Chi non è d'accordo con una
promozione la sospende o la scarta, e *quella* è annullabile.

**Una regola riattivata riparte.** Una regola attiva si giudica solo sulle prove arrivate
dopo l'ultima attivazione: altrimenti la prima revisione dopo una riattivazione a mano la
risospenderebbe per le smentite di prima. È anche una precisione mobile: una regola buona
per mesi che comincia a sbagliare si sospende sugli errori recenti, non sulla sua storia.

**«Ripassa le revisioni»** ripassa per il learner le revisioni **già chiuse**. Serve quando
il learner è stato acceso a revisione iniziata: quello che le chiusure di prima avrebbero
insegnato non gliel'ha mai visto nessuno, ma valori, correzioni e selezioni stanno a
database, e da lì si ricava esattamente quello che si sarebbe registrato al momento.

È **idempotente** — ogni documento ritira le sue prove prima di rimetterle — quindi si può
rilanciare senza gonfiare i contatori. Sugli eventi ripassati `at` resta il momento in cui
il revisore aveva chiuso, e `replayedAt` dice quando l'evento è stato scritto; `actor` è
l'account che ha lanciato il ripasso, perché chi aveva chiuso davvero non è mai stato
salvato sul documento. Un evento registrato sul momento ha `replayedAt: null`.

Vale solo in **LEARNING**: il ripasso è una registrazione come le altre. E va lanciato dopo
un cambio dell'algoritmo dell'impronta, non prima: con un'impronta che cambia a ogni
documento non farebbe che moltiplicare regole a supporto 1.

**«Esporta le regole»** scrive un JSON con regole, decisioni registrate e cronologia
(`praticaai-reviewer/learned-rules`), coi nomi dei campi e dei tipi anche nella forma di
pratica-ai dove esiste la corrispondenza, e con gli algoritmi dell'impronta esatta e della
firma normalizzata dichiarati nel manifest: quelle di template valgono solo su chi le calcola
allo stesso modo. Nessun valore dei documenti esce, come nel deposito — la firma è fatta di
soli hash.

**Limiti noti.** Serve sempre una posizione su una riga sola, con gli offset esatti: un'area
il cui testo non si ritrova fra le righe della pagina dà le righe toccate ma non gli offset,
e resta un esempio senza regola. Un valore digitato la posizione se la ritrova da sé, ma solo
quando è inequivocabile: se compare due volte nel documento, o è troppo corto perché comparire
una volta sola voglia dire qualcosa, quella revisione non insegna niente. Una prima pagina letta con OCR non ha né impronta né firma,
quindi solo regole di tipo. Una regola attiva che perde prove per uno scarto resta attiva
finché le prove contro non la sospendono. La soglia di somiglianza fra moduli non è stata
misurata su documenti reali: troppo bassa fonde stampati diversi, troppo alta riporta allo
scope template che non si attivava mai.

### Misurare su un corpus reale

`tests/pilot-corpus-benchmark.test.ts` misura l'estrazione su documenti veri contro un
manifest annotato a mano. Il tipo lo dà il manifest: non c'è più un classificatore da
misurare, e il conto dei tipi giusti è uscito dal report insieme a lui. Documenti, manifest e report stanno fuori dal
repository e arrivano solo da variabili d'ambiente; senza, il test è saltato.

```bash
PRACTICAAI_PILOT_CORPUS=/percorso/ai/documenti \
PRACTICAAI_PILOT_MANIFEST=/percorso/al/manifest.json \
PRACTICAAI_PILOT_OUTPUT=/percorso/privato/report.json \
PRACTICAAI_PILOT_LEARNED_RULES=/percorso/regole-apprese.json \
pnpm benchmark:pilot
```

L'ultima è facoltativa: senza, la misura è `BASELINE` (solo registry); con un file
«Esporta le regole», è `FROZEN`, con le regole attive del file applicate come nell'app.
Ogni documento si misura col tipo che il manifest dichiara; il report dà campi giusti,
sbagliati e mancanti, i campi attesi assenti compilati lo stesso, e quanti valori arrivano
`AUTO_ACCEPTED`, `NEEDS_REVIEW` o `CONFLICT`. Il formato del manifest e il confronto dei valori stanno in
[`docs/pilota_reale_todo.md`](docs/pilota_reale_todo.md#5-harness-del-benchmark-su-corpus-reale).

**Una misura vale solo così:**

- **codice e regole congelati.** Un commit senza modifiche aperte (il report scrive il
  commit e se era pulito) e le regole in un file esportato, mai il deposito che sta
  ancora imparando. Le regole vengono da documenti diversi da quelli del corpus;
- **corpus indipendente.** Nessuno dei documenti è servito a scrivere segnali, soglie o
  regole, né a insegnare al learner. Una misura su documenti di cui si sono guardati gli
  errori per correggere il codice è di sviluppo, non una stima: il 125/125 del pilota lo
  era;
- **annotazione senza gli output del motore.** Chi scrive il manifest legge il documento,
  non la proposta: una scheda precompilata sposta il giudizio verso quello che il motore
  ha già detto;
- **report fuori dal repository.** Contiene nomi, valori ed evidenze dei documenti.

---

## Dove finiscono i dati

Tutto sotto la cartella dati dell'app
(`~/Library/Application Support/praticaai-reviewer` su macOS,
`%APPDATA%\praticaai-reviewer` su Windows):

| File | Contenuto |
|---|---|
| `praticaai-reviewer.db` | documenti, campi e righe dei campi ripetuti, evidenze del motore e selezioni del revisore, righe del testo per pagina, classificazione, eventi, indice FTS5, le correzioni alla mappa «tipo ↔ dati» e la loro cronologia, il deposito del learner, l'azienda di cui sono i documenti |
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

**Cosa non è un importo.** Le cifre di una data sono fuori dai candidati: in «Totale al
31.12.2025 di 1.234,56» il lettore degli importi aggancerebbe «31.12», che ha la parte
decimale e passerebbe la guardia sul numero nudo, e l'importo vero non verrebbe mai
letto. Vale per entrambi i motori, perché il v2 legge gli importi con lo stesso lettore.
Solo le date che esistono coprono le loro cifre: «31.02» resta un numero come un altro.

**Numero documento e protocollo non sono lo stesso numero.** Una riga può portarli
entrambi («Fattura n. 114 - Prot. n. 2026/554321»), quindi i due si leggono con pattern
diversi: il protocollo solo dove «prot.»/«protocollo» lo annuncia, il numero documento
saltando i numeri annunciati così. Un documento che ha solo il protocollo lascia vuoto il
numero documento, perché un campo vuoto costa meno di un campo sbagliato.

**Divergenza dal registry.** `package_count` e `consumption` sono dichiarati `number`
negli schemi ma qui sono trattati come stringhe: in pratica portano un'unità di misura
(«12 colli», «540 kWh») che una normalizzazione numerica butterebbe via.

**Correzioni e rielaborazione.** Una correzione umana è legata al nome del campo e
sopravvive a una nuova estrazione dello stesso documento; lo stesso vale per un tipo
assegnato a mano, che non viene sovrascritto da un match automatico. La migrazione 0004
rinomina i 40 campi v1 sugli id dell'ontologia (`document_number` → `document.number`),
e la pipeline ritrova una correzione anche sotto l'altro nome, così cambiare motore non
la perde. Col v2 una correzione su un campo che il nuovo profilo non chiede resta come
campo a sé. Nei campi ripetuti correzione e rimozione di una riga proposta tornano sullo
stesso indice, le righe aggiunte a mano restano in coda a quelle del nuovo run, e una riga
corretta che il nuovo run non trova più diventa del revisore invece di sparire. All'avvio
col v2 i documenti in coda con la copia in cache che non sono mai passati da questa
versione dei profili, che non hanno ancora i candidati di tipo salvati (migrazione
0005), o il cui ultimo run è chiuso su un OCR non riuscito, vengono rielaborati in
sottofondo; quelli già revisionati o scartati no.

**OCR.** Copre le pagine *scansionate*, cioè quelle fatte di immagini: il motore prende
l'immagine che la pagina già contiene invece di ri-rasterizzarla. Una pagina senza testo
e senza immagini (per esempio solo grafica vettoriale) non produce testo.

Di ogni pagina escono anche le **righe con le coordinate**. Tesseract le dà in pixel
dell'immagine; la matrice con cui la pagina disegna quell'immagine — ricostruita seguendo
`save`/`restore`/`transform` sulla lista degli operatori di pdf.js — le porta nelle stesse
unità di pagina delle righe del text layer (`src/main/extract/page-placement.ts`). Senza
coordinate una selezione su una scansione non si ritrova: `locatePick` non ha righe da
toccare e deve ricadere sul testo, che il ritaglio e la pagina non leggono mai uguale. Dove
la matrice non si ricostruisce la riga resta senza riquadro: una posizione indovinata
insegnerebbe un'etichetta sbagliata. Le scansioni elaborate prima di questa versione
prendono le coordinate alla prossima rielaborazione.

**Quando l'OCR non legge.** Servizio assente (build senza `tessdata`, worker che non
parte) o richiesta fallita: il testo nativo delle altre pagine resta, ma il documento non
passa per letto. `textSource` diventa `OCR_FAILED` — nella scheda, nella tabella e nel
dataset esportato — la revisione lo avvisa, la timeline porta l'evento «OCR non riuscito»
col motivo, e il run chiude `FAILED_OCR`. È l'unico esito che non conta come passaggio del
motore: il documento viene ripassato al primo avvio in cui l'OCR funziona, invece di
restare in coda con zero campi e un run che sembra completo. Una pagina su cui l'OCR ha
girato senza trovare niente (una pagina bianca) non è un fallimento: non c'è nulla da
ritentare.

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

I file in `resources/registry/` sono due: `fields.json`, i 454 campi che il motore sa
leggere, e `document_fields.json`, le 171 classi canoniche del Brain MVP con i campi che
ognuna chiede. Vengono dal foglio `PraticaAI_Brain_MVP_Classi_Campi_Unificato` del
22/09/2026, con sopra le decisioni che il pilota aveva già preso su documenti veri. Il repo
non dipende dal monorepo PraticaAI e non ne importa nulla: quei JSON sono dati, non codice.
