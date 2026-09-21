# Dataset ed export: cosa entra nel repository e cosa no

## La regola

Gli export del Reviewer — dataset annotato, regole apprese, foglio xlsx — contengono i
documenti dei clienti: valori letti, testo dell'evidenza sotto ogni campo, nomi dei file,
identificativi Drive. **Nel repository non ci entrano.** `docs/exports/` è in `.gitignore`:
la cartella resta sul disco di chi lavora, i file non vengono versionati.

Vale per qualunque formato e qualunque data: un export non diventa pubblicabile perché è
vecchio, perché è «solo un campione» o perché serve a un'analisi.

## Cosa resta versionato

Il **manifest senza valori**, uno per export, in questa cartella:

- `2026-09-18-manifest.json` — export del 18/09/2026, app 1.5.1

Porta gli sha-256 dei file di origine, le versioni di app e motori, le classi, i conteggi
per stato, sorgente del testo, ruolo, provenienza e tipo di correzione. Non porta nessun
valore letto da un documento.

Serve a due cose: sapere su quali dati è stata misurata un'affermazione (le analisi in
`docs/` citano i conteggi, il manifest li àncora), e riconoscere se un export che qualcuno
ha sul disco è lo stesso su cui è stata scritta l'analisi — si confrontano gli sha-256.

Si rigenera così, dalla cartella dell'export che sta fuori da git:

```sh
node scripts/export-manifest.mjs docs/exports/2026-09-18 -o docs/dataset/2026-09-18-manifest.json
```

Lo script rifiuta di scrivere se nel manifest comparisse qualcosa che somiglia a un IBAN o
a un codice fiscale: è una rete di sicurezza, non un permesso di non guardare il diff.

## Dove vive l'export vero

**Da decidere.** Oggi l'export sta sul disco di chi lo ha generato e basta. Il mandato
Hermes (capitolo 7 e punto 4 di `docs/mandato-hermes-v1.8.0-analisi.md`) chiede che il
deposito dei documenti e degli export abbia un indirizzo, un proprietario e
un'autorizzazione dichiarati, prima che il pilota parta. Finché la decisione non c'è, un
export non si copia da nessuna parte.

## I valori di prova sono sintetici, e sono dichiarati

Nelle fixture e nei test si usano valori inventati. Sono questi, e nessuno appartiene a una
persona o a un'azienda reale:

| Valore | Dove | Cosa è |
|---|---|---|
| `IT60X0542811101000000123456` | fixture e test | l'IBAN di esempio della documentazione, checksum valido |
| `IT61X0542811101000000123456` | test di validazione | lo stesso con una cifra cambiata, checksum **non** valido di proposito |
| `IT60X0542811101000000999999` | test di validazione | variante non valida di proposito |
| `IT41W8000000292100645211151` | test del fact reader | secondo IBAN di esempio, checksum valido, non compare in nessun export |
| `RSSMRA80A01H501U` | `docs/new_fields.md` | il codice fiscale di esempio (Mario Rossi, Roma) |
| `ALFA S.R.L.`, `Beta Costruzioni S.p.A.` | `scripts/make-fixtures.mjs` | aziende inventate |

Chi aggiunge un valore di prova lo aggiunge qui. Un valore che non è in questa tabella e
non è ovviamente inventato va trattato come dato reale finché non si dimostra il contrario.

## Cosa non è ancora ripulito

Nei test e in due commenti del sorgente restano il **nome e la partita IVA di un cliente
reale** (`git grep -i massetti`, `git grep -i fiditalia`). Non sono IBAN né codici fiscali
di persona fisica, ma sono dati identificativi di un cliente in un repository pubblico, e
sopravvivono a qualunque riscrittura della cronologia perché stanno nel codice di oggi.
Vanno sostituiti con nomi sintetici: sono una trentina di occorrenze in dieci file di test,
`src/main/learning-anchors.ts:114` e `src/shared/document-direction.ts:26`. Il rename tocca
asserzioni che dipendono dal valore (impronta del template, ancore di classe), quindi è un
lavoro a sé, non un passaggio di questo.
