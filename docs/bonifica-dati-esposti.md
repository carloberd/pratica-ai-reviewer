# Bonifica dei dati esposti — cosa c'è, cosa è stato fatto, cosa resta da eseguire

Punto 0 di `docs/mandato-hermes-v1.8.0-analisi.md`. Scritto il 21/09/2026 su `5f75bae`.

I valori reali non sono riprodotti qui, e non vanno riprodotti in report, fixture o issue.

## 1. Cosa è esposto, misurato

`github.com/carloberd/pratica-ai-reviewer` è **pubblico**, 0 fork, ultimo push 19/09.

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

## 2. Cosa è già stato fatto (questa PR)

- `docs/exports/` è in `.gitignore`: nessun export entra più nel repository;
- i tre file dell'export sono usciti dall'indice (`git rm --cached`) e restano sul disco;
- al loro posto resta un **manifest senza valori**, `docs/dataset/2026-09-18-manifest.json`,
  generato da `scripts/export-manifest.mjs`, che rifiuta di scrivere se il risultato
  contenesse qualcosa che somiglia a un IBAN o a un codice fiscale;
- le due analisi che stavano dentro `docs/exports/` e non contengono valori si sono spostate
  in `docs/export-2026-09-18-analisi.md` e `docs/new_fields.md`;
- i valori di prova sintetici sono dichiarati in `docs/dataset/README.md`.

**Questo toglie i file dal presente, non dalla cronologia.** Chiunque abbia l'URL del commit
`a66e75c` continua a leggerli finché il punto 3 non viene eseguito.

## 3. Cosa resta da eseguire, in quest'ordine

### 3.1 Repository privato — per primo

```sh
gh repo edit carloberd/pratica-ai-reviewer --visibility private --accept-visibility-change-consequences
```

Va fatto **prima** della riscrittura, non dopo, e non è ridondante rispetto a essa: GitHub
conserva i commit delle 53 pull request mergiate e li serve dalle pagine delle PR anche dopo
un force push, perché sono raggiungibili da ref di pull request che il push non tocca. Finché
il repository è pubblico, quelle pagine restano leggibili.

Conseguenze: il repository sparisce dalla rete finché non lo si rimette pubblico; nessun
clone locale si rompe.

### 3.2 Riscrittura della cronologia

Provata su un clone `--mirror` usa e getta il 21/09: 214 commit riscritti in 0,4 s, i 5 tag
ri-puntati, zero valori reali nei blob risultanti (riverificato con la stessa scansione del
punto 1).

```sh
git clone --mirror https://github.com/carloberd/pratica-ai-reviewer.git bonifica.git
cd bonifica.git
git filter-repo --invert-paths \
  --path docs/exports/2026-09-18/praticaai-dataset-2026-09-18.json \
  --path docs/exports/2026-09-18/praticaai-dataset-2026-09-18.xlsx
# verificare qui che i valori non ci siano più, prima di spingere
git push --force --mirror https://github.com/carloberd/pratica-ai-reviewer.git
```

Il clone `--mirror` non è un dettaglio: i valori stanno anche nei 44 rami remoti delle PR
già mergiate, e una riscrittura fatta sul checkout di lavoro li lascerebbe indietro.

Si rimuovono solo i due file che portano i valori, non tutta `docs/exports/`: la cronologia
delle analisi resta leggibile.

Conseguenze, tutte reali:

- **ogni commit dal 18/09 in poi cambia sha.** `5f75bae`, la baseline dichiarata dal mandato
  Hermes (fonte R01), smette di esistere: sulla prova diventa `98a2d4e`. Il mandato va
  aggiornato, o la corrispondenza va messa a verbale;
- i cinque tag da `v1.5.4` a `v1.8.0` cambiano commit;
- ogni clone esistente va ributtato via e riclonato: un `git pull` dopo il force push
  produce una fusione delle due cronologie e rimette dentro i file;
- le pagine delle PR mergiate restano a puntare ai commit vecchi (vedi 3.1).

### 3.3 Dopo la riscrittura

- chiedere a GitHub Support la garbage collection degli oggetti resi irraggiungibili: senza,
  restano leggibili per sha. Non ci sono fork da invalidare (contati: 0);
- considerare gli IBAN e i codici fiscali esposti come **compromessi per il periodo
  18/09–oggi**, e trattarli come tali indipendentemente dalla bonifica: la riscrittura riduce
  l'esposizione, non la annulla retroattivamente;
- decidere se e quando rimettere il repository pubblico.

## 4. Cosa questa bonifica non risolve

Nel codice di oggi — quindi in qualunque cronologia, riscritta o no — restano il **nome e la
partita IVA di un cliente reale**: una trentina di occorrenze in dieci file di test, più
`src/main/learning-anchors.ts:114` e `src/shared/document-direction.ts:26`.

Non sono dati di persona fisica e non hanno la gravità di un IBAN, ma identificano un
cliente in un repository che è stato pubblico. La sostituzione con nomi sintetici tocca
asserzioni che dipendono dal valore (impronta del template, ancore di classe, piegatura del
nome societario): è una PR a sé, da fare dopo questa.
