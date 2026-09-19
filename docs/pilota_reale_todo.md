# Pilota reale — cosa prendere, cosa no

Obiettivo: integrare da `external/pilota_reale/` (fuori da git) quello che rende il tool
più misurabile e toglie errori, lasciando fuori quello che è stato tarato sugli stessi
documenti su cui poi è stato misurato.

Punto di partenza: un report (`pilot-reale-v16-report.md`) e un bundle con la storia
completa del ramo `codex/learner-v2-production` fino a `80d3f51`. I commit sono due, firmati
`Codex <codex@openai.com>` e datati 18/09/2026, entrambi su `a09fa8e` (1.5.3):

- `367cb3b` — il learner v2, già valutato in [`learner_v2_todo.md`](learner_v2_todo.md) e
  integrato in modo selettivo con #35–#40. Da qui non se ne prende altro;
- `80d3f51` — il pilota: 28 file, +1847/−89. È l'oggetto di questo documento.

---

## Cosa dice il report, e cosa non dice

Diciassette PDF/DOCX reali: sedici con un tipo del registry, più una domanda di permanenza
nella White List che deve restare `UNKNOWN`. Per ogni documento c'è un manifest con i
valori attesi (125 campi in tutto), e i due motori sono stati confrontati sullo stesso
corpus:

| Misura | 1.5.3 | Pilota |
|---|---:|---:|
| Tipo corretto (compresa l'astensione) | 11/17 | 17/17 |
| Campi corretti | 16/125 | 125/125 |
| Campi errati | 12/125 | 0/125 |

Il report lo dice da solo: le modifiche sono state scritte **guardando gli errori di quei
17 file**, quindi il 125/125 è una misura di sviluppo, non una stima su documenti nuovi.
Senza le ricette di classe (vedi sotto) lo stesso motore trova 21 campi su 125. Tolto il
lavoro su misura, cioè, il salto nell'estrazione quasi sparisce. Resta però un dato
vero, ed è il più utile del report: **su documenti reali il motore basato solo sul
registry legge circa un campo su otto.** Chi annota oggi compila quasi tutto a mano.

---

## Il criterio

Lo stesso di [`learner_v2_todo.md`](learner_v2_todo.md#il-criterio-di-selezione), preso dal
[README](../README.md#perché-esiste-e-dove-va-a-finire):

> Niente che possa mettere un valore plausibile ma sbagliato davanti a chi annota.

---

## Il verdetto

| # | Cosa | Verdetto |
|---|---|---|
| 1 | Tre guardie nel fact-reader | **Prendere** |
| 2 | Segnali del classificatore (6 classi + White List) | **Prendere potati** |
| 3 | Nota di credito con importi negativi | **Prendere** |
| 4 | `money.amount` tolto dall'estratto conto | **Non serve**: c'è già «non utile» |
| 5 | Harness del benchmark su corpus reale | **Prendere**, senza high-recall |
| 6 | 88 ricette di classe + `CLASS_PATTERN` + `recipe_id` | **Non prendere** |
| 7 | Il report con i numeri | **Non copiarlo**: descrive codice che non entra |

### 1. Tre guardie nel fact-reader

- `readText` scarta un valore che comincia con `/` o `\`: in `Ragione sociale/Nome e
  cognome`, il frammento dopo la barra è la coda dell'etichetta, non il valore della sua
  prima metà. Toglie un valore sbagliato. Nel pilota la guardia stava solo nella lettura
  larga dell'high-recall (stessa riga senza due punti), che in `main` non c'è; qui il caso
  che la raggiunge è l'etichetta andata a capo sulla barra, con `/Nome e cognome` sulla
  riga dopo.
- `riferim` si aggiunge a `PRECEDING_MARKERS` (`reference-context.ts`): «Riferim. fattura
  n. 12» cita un altro documento, non dà il numero di questo. Toglie un valore sbagliato.
- `startsSegment` accetta un'etichetta a metà riga solo se chiude la riga e la precede un
  identificativo fiscale completo (11 cifre o un codice fiscale). È il caso di
  `P.IVA 01234567890 DESTINATARIO`, che il generatore PDF fonde in una riga. Questa
  **aggiunge** una lettura invece di toglierla, ma a condizioni strette. «Destinatario» è
  davvero un'etichetta di `recipient.name`, sia negli hint v2 sia nelle keyword v1, quindi
  la guardia serve al registry com'è e non solo a un'etichetta imparata.

### 2. Segnali del classificatore, potati

Il salto di classificazione (11/17 → 17/17) viene tutto da qui. Diverse frasi però
descrivono un'azienda o un generatore di PDF, non il tipo di documento. «Autista
caposquadra» fa diventare un prospetto del costo del personale solo quello di
quell'azienda. «Dichiaro che la fotocopia» fa diventare una patente qualunque copia
conforme. Entrano solo le frasi che descrivono il tipo:

| Classe | Entra | Resta fuori |
|---|---|---|
| `white_list_prefettura` | hard negative «a permanere nella white list» (vedi sotto) | — |
| `patente_di_guida` | «fronte patente», «retro patente»; hard negative «patente a crediti» | «dichiaro che la fotocopia», «presente documento e conforme all originale» |
| `visura_camerale` | «registro imprese archivio ufficiale», «documento n estratto dal registro imprese» | «esito evasione protocollo» (è un altro documento), «numero rea» (sta nelle intestazioni di mezzo mondo) |
| `nota_di_credito` | negativo «fattura nr» | «riepilogo iva imponibile imposte» (c'è in ogni fattura), «nota di credito nr» (è anche il modo in cui una fattura cita una nota: vedi sotto) |
| `quietanza_versamento` | tutte e quattro | — |
| `rapportino_intervento` | «durata del lavoro», «durata del viaggio» | «commessa durata» (colonne fuse di un generatore), «ricetta», «costo del lavoro» |
| `prospetto_costo_del_personale` | niente | tutte e quattro: sono i reparti di un'azienda |

Le classi configurate passano da 11 a 16. Il 17/17 sul corpus del pilota probabilmente
non regge più per intero, e va bene così: quel numero valeva per quei file.

È la prima volta che `resources/registry/v2` si scosta dal programmer pack. `SNAPSHOT.txt`
lo dichiara classe per classe, così chi aggiorna il pack sa cosa riportare.

Tre cose trovate facendo la PR 2:

- **La frase della White List è più corta di quella del pilota.** La normalizzazione v2
  tiene l'apostrofo, quindi in «dell'interesse» c'è una parola sola. Scritta senza
  apostrofo, come le altre frasi del file, «comunicazione dell interesse…» non scatta mai
  su un testo che lo ha; scritta con l'apostrofo non scatta quando l'OCR lo perde. La coda
  «a permanere nella white list» scatta in tutti i casi.
- **Per lo stesso motivo alcune frasi del pack non scattano quasi mai.** «si dispone il
  rinnovo dell iscrizione», «iscrizione nell elenco dei fornitori…» e «ricevuta di
  presentazione dell istanza» (usata tre volte) valgono solo su un testo che ha perso
  l'apostrofo. Sistemarlo vuol dire decidere se la normalizzazione trasforma l'apostrofo
  in spazio, e questo tocca anche gli alias del registry: è fuori dalla sequenza.
- **«nota di credito nr» non descrive solo il tipo.** È anche la forma con cui una
  fattura cita una nota. Una fattura con «Rif. nota di credito nr. 5» nella zona del
  titolo prima restava `UNKNOWN` (nota di credito a 0,72, sotto soglia); con la frase
  diventava `nota_di_credito`, a 0,755 se scrive «Fattura nr» e a 0,99 se no. È un tipo
  plausibile e sbagliato, cioè proprio quello che il criterio esclude. La frase è entrata
  con la PR 2 come diceva la tabella, ed è **uscita con la 2b**: non c'è un corpus su cui
  misurarla prima. Il prezzo è che una nota di credito con solo il titolo e «Nota di
  credito nr.» torna sotto soglia (0,72), com'era prima della PR 2, e il tipo lo sceglie
  chi annota. Si riapre con l'harness della PR 4, cercando una frase che una fattura non
  scriva.

### 3. Nota di credito con importi negativi

L'ontologia mette `non_negative_money` su `money.total`, `money.taxable` e `money.tax`
per ogni tipo, ma una nota di credito può scrivere gli importi col meno davanti. Il
pilota aggiunge al profilo `field_validator_overrides`: i validatori di quel campo per quel
tipo, al posto di quelli dell'ontologia. Serve sia al fact-reader sia allo schema JSON
esportato verso pratica-ai, che oggi dichiara «non negativo» su un campo che non lo è.

**Verificato con la PR 3: il segno si perdeva.** `parseMoney` teneva solo le cifre, e
`findMoney` non guardava cosa c'era prima del numero: `-1.234,56`, `€ -100,00`,
`-€ 100,00`, `Totale: -100,00` uscivano tutti positivi, nel v1 e nel v2, e con la
confidence piena. Il pilota non lo risolveva: teneva il segno solo nelle sue ricette
(`signed_money`), che non entrano. La PR 3 ha sistemato la lettura prima del validatore.

Il meno conta solo se è un segno: attaccato al numero o alla valuta davanti, e preceduto
da inizio riga, spazio, due punti o uguale. Restano positivi, come prima, il trattino
staccato (`Totale - 100,00`, `- 100,00 €`), quello attaccato a una parola o a una cifra
(`Totale-100,00`, `10,00-20,00`, `051-123.456`), il lineato `–`, le parentesi contabili
`(100,00)` e il meno in coda `100,00-`. Le ultime due forme, se una nota di credito le
usa, danno ancora un importo positivo: sono rare in italiano, e le parentesi racchiudono
anche importi che non sono negativi. Si riguardano con l'harness della PR 4, se il corpus
le mostra.

Sulle fatture cambia solo l'importo scritto davvero col meno: prima passava positivo,
adesso esce negativo e va in revisione con `NEGATIVE_MONEY`. Sulla nota di credito
l'eccezione è `[]`, cioè nessun validatore: vanno bene sia il positivo sia il negativo,
perché una nota di credito li scrive in entrambi i modi. All'export, se il revisore segna
«non utile» uno dei tre importi, l'eccezione di quel campo sparisce con lui: il loader
rifiuta un'eccezione su un campo fuori profilo, e rileggendo il file esportato si
fermerebbe.

### 4. `money.amount` sull'estratto conto

Il pilota lo toglie dal profilo, e ha ragione: in un estratto conto ci sono decine di
importi e uno solo non vuol dire niente. Ma per questa decisione c'è già lo strumento:
chi annota segna il campo «non utile» dalla scheda, e l'overlay lo toglie dal profilo
senza toccare il pack. Non si fa niente nel codice.

### 5. Harness del benchmark su corpus reale

È il pezzo **11** rimasto aperto in [`learner_v2_todo.md`](learner_v2_todo.md): quello
che serve alla fase 2 per misurare, ed è la condizione per riaprire ranking, `FAMILY` e
high-recall. Il test legge corpus, manifest e file di output **solo da variabili
d'ambiente**, controlla lo SHA-256 di ogni file e senza variabili viene saltato. Documenti
e valori non entrano mai nel repository. Misura:

- classificazione: assegnato giusto, astensione, top-1;
- campi corretti / errati / mancanti, sia col tipo del classificatore sia col tipo vero;
- i campi che il manifest dichiara assenti e il motore compila lo stesso.

Si porta senza la dimensione high-recall, che in `main` non esiste. Il protocollo del
report per una misura valida entra nel README con il comando: congelare codice e regole,
corpus indipendente, annotazione fatta senza guardare gli output del motore.

### 6. Le ricette di classe — non si prendono

Sono 88 espressioni regolari su 12 classi, scritte sui documenti del pilota: «il
fornitore è la riga subito sopra `IBAN:`», «l'imposta è sulla riga che comincia con
`0%`», «l'emittente è `Agenzia delle Entrate` ovunque compaia». Su quel layout
funzionano. Su un layout diverso prendono la riga sbagliata e la **propongono**, e il
valore sembra giusto. Tre motivi in più:

- girano solo in high-recall, che è rimasto fuori per non bruciare `BASELINE`;
- ordinano i candidati con `candidateRank`, il ranking pesato che è rimandato;
- sono, a mano, le regole di modulo che il learner deve imparare dalle correzioni.
  Metterle adesso confonderebbe la misura della fase 2, che deve dire quanto impara lui.

Restano nel bundle. Si riaprono con un corpus indipendente, misurate con l'harness del
punto 5, e partendo da quelle che valgono per un tipo e non per un layout.

---

## Sequenza

Quattro PR piccole, in quest'ordine, ognuna coi gate verdi prima della successiva. Nel
gate c'è anche `pnpm build`: da #35 a #40 mancava, e il build del renderer si era rotto
senza che nessuno se ne accorgesse (`local-learning.ts` si portava dietro `node:crypto`).
L'ha riparato #41, prima della PR 1. La 2b non era prevista: toglie una frase entrata
con la 2 (vedi il punto 2).

| PR | Contenuto | Migrazione | Stato |
|---|---|---|---|
| 1 | Tre guardie nel fact-reader (punto 1) | no | fatta (#42) |
| 2 | Segnali del classificatore potati (punto 2) | no | fatta (#43) |
| 2b | Via «nota di credito nr» dai segnali (punto 2) | no | fatta (#44) |
| 3 | Nota di credito: `field_validator_overrides` e segno degli importi (punto 3) | no | fatta (#45) |
| 4 | Harness del benchmark su corpus reale (punto 5) | no | da fare |
