# Learner v2 — cosa prendere, cosa no

Obiettivo: integrare in modo selettivo il ramo `codex/learner-v2-production`, tenendo
quello che fa imparare il tool e lasciando fuori quello che, adesso, rischia di sporcare
il dataset.

Punto di partenza: `external/learner_v2/` (fuori da git), che contiene tre viste dello
stesso commit `367cb3b` — un bundle con la storia completa, la stessa cosa in formato
patch, e due documenti copiati da `docs/`. Il commit è firmato `Codex <codex@openai.com>`,
datato 18/09/2026: 47 file, +1830/−235.

Verificato eseguendolo in un worktree: 65 file di test e 722 test verdi, `tsc` node e web
puliti, `biome check` pulito. Il ramo sta in piedi — ma su `a09fa8e` (1.5.3), non su
`main`.

---

## Il criterio di selezione

Dalle tre fasi in [README, «Perché esiste, e dove va a finire»](../README.md#perché-esiste-e-dove-va-a-finire):
adesso il prodotto non è l'app, è il **dataset annotato corretto**. Da lì scende il
criterio che decide quasi tutte le righe di questa tabella:

> Niente che possa mettere un valore plausibile ma sbagliato davanti a chi annota.

Un campo vuoto si vede e si compila. Un valore sbagliato che *sembra* giusto passa la
revisione e finisce nel training. Per questo alcune cose tecnicamente buone del ramo —
il ranking pesato, `FAMILY`, l'high-recall — qui sono rimandate: non perché siano
sbagliate, ma perché non sono verificabili finché il corpus non esiste, e nel frattempo
cambiano cosa viene proposto.

---

## Il verdetto

| # | Cosa | Peso | Verdetto |
|---|---|---:|---|
| 1 | Firma normalizzata del template (fuzzy) | +142 | **Prendere** — sblocca l'apprendimento |
| 2 | `inferExactValuePick` (valore digitato → ancora) | +96 | **Prendere** — è il pezzo giusto per questa fase |
| 3 | Fix `documentEntityWords` (id vs `name`) | +3 | **Prendere** — è un bug fix nascosto nel diff |
| 4 | Parsing JSON difensivo (`parseObject`, `parseNumbers`, `parseLines`) | ~40 | **Prendere** — indurimento, zero comportamento |
| 5 | Colonne di provenienza (`strategy`, `candidate_score`, `rule_scope`) | ~30 | **Prendere** — attrezzatura per misurare dopo |
| 6 | Rollback atomico + azione `REVERT` | ~120 | **Prendere** — governo, non estrazione |
| 7 | `ruleReliability()` bayesiana | +8 | **Prendere solo la funzione**, non i pesi |
| 8 | Ranking online pesato (`candidateRank`) | ~60 | **Rimandare** — pesi inventati |
| 9 | Livello `FAMILY` | ~80 | **Rimandare** — non validabile senza corpus |
| 10 | High-recall (`same-line-loose` + fallback) | ~150 | **Non prendere così** |
| 11 | Benchmark: script e protocollo | +133 | **Prendere l'impalcatura**, riscrivere le affermazioni |

Sette pezzi su undici, circa metà del patch.

---

## Prendere subito

**1. La firma normalizzata è il vero motivo per fare questa integrazione.** Non è un
miglioramento incrementale: oggi lo scope `TEMPLATE` — il più preciso che il learner ha —
è morto in partenza. Il commento nella migrazione `0013` lo dice già, misurato: ogni
impronta esatta corrispondeva a un solo documento, tre visure tre impronte, quindi
`minTemplateSupport: 2` non è raggiungibile mai. Un learner che non può attivare la sua
regola migliore non impara. La firma Jaccard raggruppa gli esemplari senza conservare né
testo né valori, è una funzione pura testabile senza documenti, ed è **regole, non pesi** —
quindi resta leggibile quando il tool entra in pratica-ai.

Riserva: `0,68` è un numero scelto a occhio. Va ritarato sul corpus vero, e annotato come
provvisorio finché non lo è.

**2. `inferExactValuePick` è tagliato su cosa si sta facendo adesso.** Oggi chi digita un
valore invece di selezionarlo non insegna niente: nessun pick, nessuna ancora, nessuna
regola. Durante l'annotazione a mano si digita di continuo. La guardia è quella giusta:
accetta solo se una forma verbatim del valore compare **una volta sola in tutto il
documento**, altrimenti rinuncia. Rifiuta invece di indovinare, che è il criterio di
questa fase.

Si incastra pulito con quanto c'è già in `main` dalla 1.5.4 (`textCorrected`, la selezione
che sopravvive alla ripulitura OCR): `inferExactValuePick` gira solo quando il pick manca.

**3. Un bug fix travestito da refactor.** Gli eventi portano l'id ontologico (`name`),
alcuni chiamanti passano l'id di riga, quindi la guardia che impedisce di imparare
un'ancora fatta dei dati del documento stesso *non stava scattando*. Tre righe, e previene
regole che funzionano solo su un cliente.

**4.** Parsing difensivo su `pattern_json`, `numbers_json` e `lines_json`: un JSON corrotto
disabilita la singola regola invece di far cadere la lettura.

**5. Le colonne di provenienza valgono più adesso che quando le hanno scritte.** Tre
colonne nullable, nessun cambio di comportamento, e sono l'unica cosa che renderà
analizzabile la misura della fase 2: senza `rule_scope` e `candidate_score`, quando il
pre/post sul corpus reale darà un numero deludente non si saprà *quale* parte l'ha
prodotto.

**6. Il rollback** perché oggi «scarta» è irreversibile: un clic sbagliato perde una regola
per sempre, senza rete. È append-only e non tocca l'estrazione. Cambia però una promessa
scritta («una regola scartata non torna») — README e testo del pulsante vanno aggiornati
insieme, cosa che il ramo fa già.

---

## Rimandare a quando c'è il corpus

**8 e 9 hanno lo stesso difetto: sono tarature senza dati.** I pesi di `candidateRank`
(0,12 / 0,16 / 0,04…) non li ha validati nessuno, e `moreSpecific` passa da «livello, poi
lunghezza» a `a.rankScore > b.rankScore`, cioè cambia **quale valore viene proposto** su
ogni documento, anche in estrazione da solo registry. `FAMILY` chiede 5 conferme al 95%
per attivarsi: non è né verificabile né tarabile oggi, e una regola di famiglia sbagliata
si propaga su un intero gruppo di tipi. Entrambi sono la classe di rischio che la fase di
annotazione non deve correre.

Di tutto questo si prende `ruleReliability()` (**7**): il prior Beta(1,1) è principiato,
sono otto righe, e impedisce che una regola con due conferme sembri più sicura di una con
cento conferme e un errore. Vale la pena portare anche `support`/`precision`/`reliability`
dentro `LearnedLabel`: è cablaggio che non decide niente finché il ranking resta spento.

Quando si prenderà `FAMILY`, **non replicare la scorciatoia `scope`/`scope_level`**: il
CHECK della `0011` va rifatto ricostruendo la tabella, non aggirato con una colonna ombra
che scrive `CLASS` dove il valore è `FAMILY`.

---

## Non prendere così com'è

**10. L'high-recall lavora contro l'obiettivo di adesso.** Due motivi indipendenti:

- È cablato `highRecall: true` in `pipeline.ts` senza guardare la modalità. Quindi
  **`BASELINE` smette di essere una baseline** — ed è lo strumento con cui si misurerà la
  fase 2. Si brucerebbe il metro prima di usarlo.
- La lettura loose, senza due punti a delimitare, può rastrellare la colonna accanto: una
  riga `Cliente Alfa Srl   Agente Rossi` con spaziatura irregolare finisce col dare
  `Alfa Srl Agente Rossi`. A 0,64 non viene auto-accettata — ma **viene precompilata**,
  cioè finisce sotto gli occhi di chi annota come valore plausibile.

Salvabile la metà più difendibile, e separatamente: il fallback senza etichetta per
**identificativi a forma forte** (IBAN, targa, VIN, codice fiscale). Lì tre condizioni si
sommano — formato rigido, valore unico nel documento, un solo campo di quel tipo nel
profilo — e il rischio è di un altro ordine. Anche quello va messo dietro un flag legato
alla modalità, spento in `BASELINE`.

**11.** Del benchmark si prende lo script `pnpm benchmark:learner` e il protocollo
pre/post, non i numeri. Il test attuale è una fixture con la regola **costruita a mano**
(`positiveCount: 8`), e il `pre = 6` è garantito per costruzione: va tenuto come test di
regressione e chiamato così. La sezione «Limiti e release gate» del loro `benchmark.md` è
invece onesta e ben scritta.

---

## Ostacoli da togliere comunque

Valgono qualunque pezzo si porti, perché stanno fra il ramo e `main`.

**Collisione di migrazione — bloccante.** Il ramo aggiunge
`0015_incremental_learner_v2.sql`; `main` ha già `0015_pick_text_corrected.sql`, arrivata
con la 1.5.4. In `src/main/db/index.ts` le migrazioni si applicano per prefisso numerico e
`schema_migrations.version` è PRIMARY KEY, col set `applied` letto una volta sola:

- database esistente: `0015` risulta già applicata, la migrazione del learner viene
  **saltata in silenzio**, poi le query cercano colonne che non esistono;
- database nuovo: la prima applica e registra `0015`, la seconda tenta l'INSERT e va in
  violazione di chiave — errore all'avvio.

Va rinumerata a `0016`.

**Il ramo parte da 1.5.3.** `git merge-tree` dà cinque file in conflitto: `README.md`,
`package.json`, `src/main/db/dao/evidence.ts`, `src/main/db/rows.ts`,
`tests/db-migrations.test.ts`. Sono meccanici — le due INSERT su `evidence` aggiungono
colonne diverse alla stessa statement — ma vanno risolti a mano.

---

## Sequenza

Sei PR piccole, in quest'ordine, ognuna coi gate verdi prima della successiva.

| PR | Contenuto | Migrazione | Stato |
|---|---|---|---|
| 1 | Firma normalizzata + campo nel manifest di export | `0016` | da fare |
| 2 | `inferExactValuePick` | no | fatta (#36) |
| 3 | Fix `documentEntityWords` + parsing difensivo | no | da fare |
| 4 | Colonne di provenienza | sì | da fare |
| 5 | Rollback `REVERT` | no | da fare |
| 6 | `ruleReliability` + cablaggio in `LearnedLabel`, ranking spento | no | da fare |

Le prime due cambiano davvero la capacità del tool di imparare; dalla terza in giù è
terreno preparato per quando il dataset esisterà.

Rimandate esplicitamente, da riaprire col corpus in mano: ranking pesato (8), `FAMILY`
(9), high-recall (10), benchmark sul corpus reale (11).
