# Bonifica dei dati esposti — cosa c'era, cosa è stato fatto, cosa resta

Punto 0 di `docs/mandato-hermes-v1.8.0-analisi.md`. Eseguito il 21/09/2026.

I valori reali non sono riprodotti qui, e non vanno riprodotti in report, fixture o issue.

## 1. Cosa è esposto, misurato

`github.com/carloberd/pratica-ai-reviewer` è stato **pubblico** dal 18 al 21 settembre, con
0 fork. Quello che segue è la misura fatta il 21, prima di toccare qualunque cosa.

Scansione di **tutti i 1061 blob** della cronologia (tutti i ref, non solo `main`), inclusi
gli archivi compressi aperti in memoria, contro i 5 IBAN e i 2 codici fiscali di persona
fisica presenti nell'export del 18/09:

| Percorso | Valori reali |
|---|---:|
| `docs/exports/2026-09-18/praticaai-dataset-2026-09-18.json` | 7 |
| `docs/exports/2026-09-18/praticaai-dataset-2026-09-18.xlsx` | 7 |
| qualunque altro blob, su qualunque ref | 0 |

I 5 IBAN passano il checksum mod-97: non sono sintetici. I 2 codici fiscali sono di persone
fisiche. I due file entrano con il commit `a66e75c` del 18/09 e da lì non cambiano più: gli
altri diciassette commit su `docs/exports/` toccano le analisi, non l'export.

Gli IBAN che compaiono nei test **non** sono questi: sono valori di esempio, dichiarati in
`docs/dataset/README.md`.

Il terzo export, `praticaai-regole-apprese-2026-09-18.json`, non porta valori: solo
etichette, hash e bbox. Una delle etichette apprese è il nome di un cliente — vedi il
punto 4 qui sotto, che non si risolve riscrivendo la cronologia.

## 2. Cosa ha fatto la PR #54

- `docs/exports/` è in `.gitignore`: nessun export entra più nel repository;
- i tre file dell'export sono usciti dall'indice (`git rm --cached`) e restano sul disco;
- al loro posto resta un **manifest senza valori**, `docs/dataset/2026-09-18-manifest.json`,
  generato da `scripts/export-manifest.mjs`, che rifiuta di scrivere se il risultato
  contenesse qualcosa che somiglia a un IBAN o a un codice fiscale;
- le due analisi che stavano dentro `docs/exports/` e non contengono valori si sono spostate
  in `docs/export-2026-09-18-analisi.md` e `docs/new_fields.md`;
- i valori di prova sintetici sono dichiarati in `docs/dataset/README.md`.

Questo toglie i file dal presente, non dalla cronologia: da solo non sarebbe bastato, ed è
il motivo del punto 3.

## 3. Cosa è stato eseguito, il 21/09

### 3.1 Repository privato, per primo

```sh
gh repo edit carloberd/pratica-ai-reviewer --visibility private --accept-visibility-change-consequences
```

Fatto **prima** della riscrittura, e non è ridondante rispetto a essa: GitHub conserva i
commit delle pull request mergiate su ref `refs/pull/*` che un force push non può toccare.
Non è una previsione, è quello che ha risposto il push della riscrittura:

```
! [remote rejected] refs/pull/53/head -> refs/pull/53/head (deny updating a hidden ref)
```

Cinquantaquattro ref di pull request rifiutati, uno per PR. Finché il repository fosse
rimasto pubblico, quelle pagine avrebbero continuato a servire i file.

### 3.2 La PR del contenimento, poi la riscrittura

La PR #54 è stata mergiata prima di riscrivere, così la riscrittura si porta dentro anche
il `.gitignore` e il manifest.

```sh
git clone --mirror https://github.com/carloberd/pratica-ai-reviewer.git bonifica.git
cd bonifica.git
git filter-repo --invert-paths \
  --path docs/exports/2026-09-18/praticaai-dataset-2026-09-18.json \
  --path docs/exports/2026-09-18/praticaai-dataset-2026-09-18.xlsx
git push --force --mirror https://github.com/carloberd/pratica-ai-reviewer.git
```

217 commit riscritti. Il clone `--mirror` non è un dettaglio: i valori stavano anche nei 44
rami remoti delle PR già mergiate, e una riscrittura fatta sul checkout di lavoro li avrebbe
lasciati indietro. Si rimuovono solo i due file che portano i valori, non tutta
`docs/exports/`: la cronologia delle analisi resta leggibile.

Verificato prima di spingere, e di nuovo dopo: la stessa scansione del punto 1 sul
repository riscritto dà **zero** su tutti i blob, e l'albero di `main` è identico byte per
byte a quello di prima — la riscrittura ha cambiato la cronologia, non il contenuto di oggi.

Sha nuovi, da usare al posto dei vecchi:

| | prima | dopo |
|---|---|---|
| `main` | `c503eda` | `7d5cf7f` |
| `v1.8.0`, baseline del mandato (fonte R01) | `5f75bae` | `98a2d4e` |

I 36 ref fra rami e tag su `origin` sono stati confrontati uno per uno con la versione
riscritta: identici.

### 3.3 Il clone di lavoro

Riportato sulla cronologia nuova (`git fetch --prune --tags --force`, `git reset --hard
origin/main`), cancellati i venti rami locali rimasti sulla cronologia vecchia, reflog
scaduto e `git gc --prune=now`. Scansione dei 1068 blob rimasti: zero valori reali.

**Chiunque altro abbia un clone deve buttarlo via e riclonare.** Un `git pull` sulla
cronologia vecchia fonde le due storie e rimette dentro i file.

### 3.4 Una cosa andata storta, e cosa insegna

Il merge della PR #54 ha **cancellato dal disco** i tre file dell'export: erano tracciati in
`main` fino al commit precedente, e il checkout li ha rimossi come rimuove qualunque file
che il commit nuovo non ha. Sono stati recuperati dalla cronologia e verificati contro gli
sha-256 del manifest: identici. Il manifest ha fatto il suo mestiere il giorno in cui è
nato.

Dopo la riscrittura quel recupero non è più possibile: **l'export esiste ora in una copia
sola, quella su disco**. Prima di toccarlo, copiarlo.

## 4. Cosa resta

- **Chiedere a GitHub Support la garbage collection** degli oggetti resi irraggiungibili:
  senza, restano leggibili per sha da chi lo conosce e dalle pagine delle PR. Non ci sono
  fork da invalidare (contati: 0).
- **Trattare i 5 IBAN e i 2 codici fiscali come compromessi** per il periodo 18/09–21/09,
  indipendentemente dalla bonifica: la riscrittura riduce l'esposizione, non la annulla
  retroattivamente.
- **Decidere se e quando rimettere pubblico il repository.** Non prima della garbage
  collection, e non prima della PR del punto 5.
- **Aggiornare il mandato Hermes**, che dichiara `5f75bae` come baseline: quel commit non
  esiste più.

## 5. Cosa questa bonifica non risolve

Nel codice di oggi — quindi anche nella cronologia riscritta — restano il **nome e la
partita IVA di un cliente reale**: una trentina di occorrenze in dieci file di test, più
`src/main/learning-anchors.ts:114` e `src/shared/document-direction.ts:26`.

Non sono dati di persona fisica e non hanno la gravità di un IBAN, ma identificano un
cliente in un repository che è stato pubblico dal 18 al 21 settembre. La sostituzione con
nomi sintetici tocca
asserzioni che dipendono dal valore (impronta del template, ancore di classe, piegatura del
nome societario): è la PR successiva, e va fatta prima di rimettere pubblico il repository.
