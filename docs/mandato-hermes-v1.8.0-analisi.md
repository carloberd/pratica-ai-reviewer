# Mandato Hermes v1.8.0 — analisi, verifica e cosa si può fare oggi

Obiettivo: leggere il mandato `PraticaAI_Mandato_Hermes_Reviewer_v1.8.0.docx`, verificare
contro il codice quello che afferma, dire cosa chiede davvero, cosa gli manca e da dove si
parte con quello che abbiamo.

Punto di partenza: il documento sta in `external/` (fuori da git), è la **revisione 2** del
mandato Reviewer — fonde il mandato precedente con un'integrazione «Local Document AI» —
ed è datato 20/09/2026. Dichiara come baseline il commit `5f75bae`, che è `main` alla
1.8.0. È generato a macchina: i metadati del `.docx` sono quelli vuoti del template, quindi
«verificato il 20 settembre» è un'affermazione del testo, non una prova dei metadati.

Analisi scritta il 21/09/2026 su `5f75bae`. Gli sha citati qui sono quelli di prima della
bonifica del punto 0, che la sera del 21 ha riscritto la cronologia: la corrispondenza con
i nuovi è nel punto 0, in fondo.

---

## Cosa chiede

Una **proof of concept locale** che aumenti i campi estratti correttamente e riduca il
lavoro di revisione, misurando il rischio di errore su documenti reali. Tutto il resto —
25 capitoli, 12 deliverable, 10 PR, 5 fasi — serve a rispondere a una sola domanda, scritta
al capitolo 20:

> a classe corretta nota, NuExtract3 aumenta i valori corretti e riduce le correzioni
> rispetto all'estrattore corrente, a costi sostenibili?

Su cinque classi: fattura, nota di credito, estratto conto bancario, rapportino di
intervento, DURC. Gli otto esperimenti previsti:

| Sigla | Configurazione |
|---|---|
| B0 | fact reader e registry correnti, `BASELINE` |
| B1 | stesso motore con snapshot `FROZEN` del learner |
| N0 | NuExtract3 zero-shot, stesso testo della baseline |
| N1 / N3 | N0 più uno o tre esempi gold, da un pool congelato |
| NV | NuExtract su immagini, per separare l'effetto visuale da un nuovo OCR |
| NP | ablazione del parser (Docling / Paddle) |
| NR | variante con reasoning, solo su casi predefiniti |

### Le tre cose che il mandato non vuole

1. **Che la pubblicazione automatica passi di straforo.** `auto_publish_enabled` resta
   `false`, alta confidence non è autorizzazione, e «zero falsi ottenuto lasciando il flag
   spento» non è una prova. Servono tre gate distinti: review assistita, accettazione del
   campo, pubblicazione del documento.
2. **Che il modello diventi l'oracolo di sé stesso.** Un valore proposto non porta con sé
   una posizione affidabile: l'evidenza va risolta contro il `NormalizedDocument` da un
   resolver indipendente, e in assenza di riscontro il campo è `UNGROUNDED` e non si
   auto-accetta. Bbox e confidence generate dal modello non sono verifiche.
3. **Che i numeri si scelgano dopo.** Soglie, margine di non inferiorità, numerosità minima
   e rischio tollerato vanno fissati con il responsabile prodotto **prima** di aprire il
   holdout.

### La distinzione che regge tutto il capitolo 18

`GOLD` è una **qualità del dato**; `TRAIN`, `DEVELOPMENT`, `CALIBRATION` e `BLIND_HOLDOUT`
sono **ruoli d'uso**. Sono due dimensioni separate: una label verificata può stare nel
training oppure nel holdout, ma il fatto che sia gold non la rende usabile in entrambi. È la
distinzione che oggi nel nostro dataset non esiste, ed è il motivo per cui quasi tutto il
resto si blocca (vedi «Cosa manca», punto 1).

---

## La baseline è verificata davvero

Il mandato cita undici fonti del repository (`R01`–`R11`). Le ho controllate una per una.
Nessuna è risultata falsa: chi l'ha scritto ha letto il codice, non il README.

| Affermazione del mandato | Riscontro |
|---|---|
| Baseline `5f75baea828791882ab4ffb112d0598df0323011` [R01] | è `HEAD`, tag 1.8.0 del 19/09 |
| OCR scelto sulle pagine sotto i 100 caratteri [R04] | `src/main/extract/text.ts:16` |
| Soglia template 0,68 iniziale da calibrare | `src/shared/local-learning.ts:308` |
| Il learner attiva con 2–3 conferme [R03] | `minTemplateSupport: 2`, `minClassSupport: 3` in `local-learning.ts:311-313` |
| «la reliability bayesiana è informativa e non governa `nextRuleStatus`» [R03] | esatto: `ruleReliability` (Laplace) non compare in `nextRuleStatus` |
| I campi invariati diventano `CONFIRMED` alla chiusura della review [R05] | `src/shared/review-learning.ts:138,151` |
| L'harness distingue oracle ed end-to-end [R07] | `tests/pilot-corpus-benchmark.test.ts:64-67,163` |
| I cinque `class_id` del pilot esistono nel registry [R08] | tutti in `resources/registry/v2/` |
| Provenance `ENGINE`/`REVIEWER`/`COMPUTED` dalla 1.8.0 [R10] | `src/shared/dataset.ts:112-118` |
| I sette punti di estensione proposti | `pipeline.ts`, `extract/text.ts`, `profile-loader.ts`, `fact-reader.ts`, `db/migrations`, `review-learning.ts`, `tests/helpers/pilot-benchmark.ts` — esistono tutti |

Questo conta più di quanto sembri: significa che le critiche del mandato al comportamento
attuale sono precise, non generiche, e che vanno prese sul serio. In particolare quella su
`CONFIRMED`.

### Perché `CONFIRMED` sui campi invariati è il problema che è

In `review-learning.ts` un campo `ENGINE`, non vuoto e non toccato dal revisore, alla
chiusura della review emette una decisione `CONFIRMED`. È una convenzione operativa
ragionevole per il learner — una proposta tenuta è un esempio positivo — ma **non è una
verifica indipendente**: il revisore può non averlo guardato. Oggi quel `CONFIRMED` alimenta
supporto e precisione delle regole, e domani alimenterebbe il gold. Il mandato chiede di
separare *confermato esplicitamente*, *corretto*, *lasciato invariato* e *non verificato*.
Senza quella separazione, ogni metrica costruita sul nostro dataset misura sé stessa.

---

## Il capitolo 7 sui dati esposti è confermato, ed è peggio di com'è scritto

Il mandato lo segnala come priorità immediata e non dichiara la bonifica eseguita.
Verificato il 21/09:

- `github.com/carloberd/pratica-ai-reviewer` era **pubblico** (lo è stato dal 18 al 21/09);
- `docs/exports/2026-09-18/praticaai-dataset-2026-09-18.json` **e** il `.xlsx` gemello sono
  tracciati da git e contengono **5 IBAN italiani distinti e 2 codici fiscali di persona
  fisica**, oltre ai nomi; sono gli unici due blob della cronologia a portarli, verificato
  su tutti i ref;
- i 5 IBAN passano tutti il checksum mod-97: non sono valori sintetici;
- entrano con il commit `a66e75c` del 18/09 e da lì non cambiano più: gli altri diciassette
  commit su `docs/exports/` toccano le analisi, non l'export.

Conseguenze pratiche: **cancellare i file non basta**, perché il dato resta nella
cronologia; e cloni e cache di GitHub sono già fuori dal nostro controllo (fork nessuno,
contati), quindi la riscrittura della history riduce l'esposizione ma non la annulla
retroattivamente.

I valori non sono riprodotti qui, né vanno riprodotti in report, fixture o issue.

Chiuso il 21/09 — repository privato, export fuori da git, cronologia riscritta: il
resoconto è in `docs/bonifica-dati-esposti.md`, e quello che resta aperto sta lì. Finché
non era chiuso, nessuna delle dieci PR del mandato aveva senso di partire.

---

## Cosa manca dal mandato

### 1. Il collo di bottiglia non è NuExtract, è il gold — e il mandato non lo mette in fase 0

Il capitolo 18 dice che gli export già revisionati con i suggerimenti a video servono per
sviluppo e regressione ma **richiedono qualificazione per la prova finale**. Il capitolo 16
spiega perché (il `CONFIRMED` qui sopra). Il problema è che quello *è* l'unico dato
verificato che possediamo: di `BLIND_HOLDOUT` oggi esiste zero.

Quindi il primo gate del capitolo 24 non è dimostrabile con i dati che abbiamo, quale che
sia la qualità di NuExtract. La modalità `GOLD_BLIND` del Reviewer — documento e schema
senza valori suggeriti — è la capacità che sblocca tutto il resto, e nella sequenza A–J
compare solo implicitamente dentro la PR B («stati della verifica»). Va promossa a PR
propria e messa in fase 0, in parallelo all'audit.

### 2. La sequenza delle PR si contraddice

Il capitolo 22 dice «non subordinare il primo confronto NuExtract alla costruzione di tutta
l'architettura futura». Poi dichiara `E ← B–D`: il primo numero arriva dopo split,
migrazioni, shadow store, compiler e adapter. In pratica **N0 si misura con l'harness che
esiste già** (`tests/helpers/pilot-benchmark.ts`, 407 righe, con oracle ed end-to-end).
Lo shadow store serve a N1/N3 e alle ablazioni, non al primo confronto.

### 3. Le cinque classi non sono cinque lavori uguali

Dai profili del registry (`resources/registry/v2/class_extraction_profiles_v2.json`,
500 profili in tutto):

| Classe | required | core | optional | conditional | stato schema |
|---|---:|---:|---:|---:|---|
| `accounting.fattura` | 5 | 9 | 0 | 3 | `READY_FOR_FIELD_TEST` |
| `payroll_contributions.durc` | 6 | 1 | 6 | 0 | `READY_FOR_FIELD_TEST` |
| `banking.estratto_conto_bancario` | 0 | 8 | 5 | 0 | `DRAFT` |
| `accounting.nota_di_credito` | 0 | 8 | 2 | 0 | `DRAFT` |
| `sales_customers.rapportino_intervento` | 0 | 8 | 2 | 0 | `DRAFT` |

Tre su cinque sono ancora `DRAFT` e quattro su cinque non hanno **nessun** `required_fields`.
Il capitolo 9 prevede che Hermes dichiari i gap, ma non dice che il costo è asimmetrico: la
fattura è pronta al test, il rapportino va progettato prima.

### 4. Il corpus non ha un indirizzo

`tests/pilot-corpus-benchmark.test.ts` è opt-in via `PRACTICAAI_PILOT_CORPUS` e
`PRACTICAAI_PILOT_MANIFEST`, e il corpus non sta nel repo. Il gate d'uscita della fase 0 è
«pipeline baseline riproducibile», ma il capitolo 7 vieta di rimettere i documenti nel
repository e il mandato non dice dove vivono, chi li possiede e con quale autorizzazione.
Va deciso prima della fase 0, non dopo.

### 5. La catena delle revisioni non si ricostruisce

Il paragrafo «Fonte di continuità» cita come documento precedente
`PraticaAI_Mandato_Hermes_Reviewer_v1.8.0`, cioè il nome di questo stesso file. Due
revisioni diverse con lo stesso nome: dai nomi non si risale a quale versione ha deciso
cosa. Le prossime revisioni vanno numerate.

---

## Quanti dati abbiamo davvero

Inventario dall'export del 18/09 (`praticaai-dataset-2026-09-18.json`, formato 1.3.0,
motore `extraction-brain-v2/2.1.0-draft.1`): **43 documenti, 41 revisionati, 2 scartati,
281 correzioni**, distribuiti su **23 classi**.

Sulle cinque classi del pilot:

| Classe del pilot | Documenti revisionati |
|---|---:|
| `payroll_contributions.durc` | 4 |
| `accounting.fattura` | 3 |
| `banking.estratto_conto_bancario` | 1 |
| `accounting.nota_di_credito` | **0** |
| `sales_customers.rapportino_intervento` | **0** |

**Otto documenti in tutto, su due classi vuote.** Per sorgente: 34 `NATIVE_TEXT`, 7 `OCR`,
2 `DOCX` — quindi le scansioni sono rappresentate da sette documenti sull'intero corpus, e
l'ablazione del parser (NP) non ha materiale.

Questo è il numero che decide il piano. Con otto documenti, nessuno dei quali annotato alla
cieca, il capitolo 24 dà un solo esito possibile: **`DATA_INSUFFICIENT`**. Non è un fallimento
del pilot, è il suo primo risultato legittimo — il mandato lo prevede esplicitamente e chiede
di consegnarlo «con il fabbisogno preciso, senza promuovere la classe o gonfiare metriche».

Il lavoro vero della fase 0 non è scrivere l'adapter: è **raccogliere documenti e annotarli
alla cieca**.

---

## Cosa possiamo fare oggi

In ordine, e con dipendenze reali.

### 0. Contenimento dei dati esposti — prima di tutto, e non è una decisione tecnica

Le opzioni non sono equivalenti e la scelta è tua:

- **repo privato subito**: ferma l'emorragia in un minuto, lascia il dato in cronologia;
- **rimozione + riscrittura della cronologia** (`git filter-repo`) + force push + richiesta
  a GitHub di invalidare le cache dei fork: più completa, rompe i cloni esistenti, e va
  coordinata perché il repo ha PR mergiate sopra quei commit;
- in entrambi i casi: `docs/exports/` in `.gitignore`, e l'export che resta nel repo
  diventa un **manifest senza valori** (hash, classe, conteggi) più fixture sintetiche
  dichiarate tali.

**Eseguito il 21/09**, con il resoconto in `docs/bonifica-dati-esposti.md`: repository
privato, export fuori da git con un manifest senza valori al loro posto (PR #54), e
cronologia riscritta con `git filter-repo` su clone `--mirror`. La scansione di tutti i
blob, su tutti i ref, dà zero valori reali; l'albero di `main` è rimasto identico.

Due conseguenze che toccano questo documento:

- **la baseline `5f75bae` non esiste più.** La fonte R01 del mandato va riscritta:
  l'equivalente nella cronologia nuova è `98a2d4e` (tag `v1.8.0`), e `main` è `7d5cf7f`.
  Tutti gli sha citati qui sotto e in `docs/` sono di prima della riscrittura;
- resta da chiedere a GitHub la garbage collection degli oggetti irraggiungibili, e resta
  nel codice di oggi il nome di un cliente reale nei test — vedi il punto 5 della bonifica.
  Finché non è ripulito, il repository non torna pubblico.

### 1. Gap matrix (D01) — pronta

Buona parte è in questo documento: baseline confermata, componenti riusabili, punti di
estensione verificati, stato dei profili delle cinque classi, inventario del corpus. Manca
la distinta delle licenze (capitolo 7), che si compila solo quando si sceglie cosa scaricare.

### 2. `GOLD_BLIND` nel Reviewer — è la PR che sblocca il resto

Concretamente: una modalità di revisione che non mostra i valori proposti dal motore, e
quattro stati di verifica distinti al posto dell'attuale `CONFIRMED` implicito
(`confermato esplicitamente`, `corretto`, `lasciato invariato`, `non verificato`), più gli
stati per l'assenza (`ABSENT_VERIFIED`, `NOT_APPLICABLE`, `UNREADABLE`, `NOT_REVIEWED`,
`NOT_FOUND_BY_ENGINE`). È additiva: migration nuova, nessuna riscrittura del learner.

Senza questa, qualunque numero misurato dopo è misurato contro sé stesso.

### 3. Piano di raccolta del corpus — quantificato

Da consegnare come `DATA_INSUFFICIENT` con il fabbisogno preciso: quante fatture, di quanti
emittenti diversi, quante scansioni, quante note di credito (oggi zero), quanti rapportini
(oggi zero), e da dove arrivano con quale autorizzazione. Più la decisione su dove vive il
deposito, dato che nel repo non può stare.

### 4. N0 sulla sola fattura — il primo numero vero, senza costruire nulla

`accounting.fattura` è l'unica classe con schema `READY_FOR_FIELD_TEST`, `required_fields`
popolati e documenti disponibili. Con l'harness esistente si misura B0 contro N0 senza
shadow store, senza compiler generalizzato, senza migrazioni. Tre documenti non decidono
niente sul merito — ma il percorso tecnico (template, adapter, evidence resolver, scorer)
si valida su tre documenti esattamente come su trecento, e quando il corpus arriva è già
pronto.

### Cosa non fare adesso

Docling, Paddle, embedding, reranker, classifier gerarchico, fallback visuale, LoRA. Il
mandato stesso lo dice al capitolo 25: «solo i gap osservati giustificano l'estensione di
parser, OCR, retrieval, contesto o modelli più pesanti». Oggi gap osservati non ce ne sono,
perché non abbiamo ancora misurato niente.

---

## In una riga

Il mandato è tecnicamente solido e onesto sui propri limiti; il suo punto cieco è di aver
messo l'architettura in fase 0 e i dati in fondo, mentre con 8 documenti sulle cinque classi
e zero annotazioni cieche l'unico lavoro che sblocca gli altri è `GOLD_BLIND` più la
raccolta del corpus — dopo aver chiuso l'esposizione degli IBAN.
