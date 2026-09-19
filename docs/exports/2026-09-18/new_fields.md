# Campi nuovi — cosa chiedono le note del revisore

Obiettivo: trasformare le note scritte in revisione (`review_note`, export del 18/09) in
campi che il motore chiede e che il dataset porta, senza toccare quello che il revisore
può già decidere da solo dalla mappa.

---

## Da dove si parte

L'export del 18/09 ha 43 documenti; 13 hanno una nota. Le note sono state confrontate con
il profilo del tipo (`resources/registry/v2/class_extraction_profiles_v2.json`) e con
l'ontologia (`field_ontology_v2.json`, 248 campi).

### Le note, una per una

| Documento | Tipo finale | Nota (abbreviata) | Di che cosa si tratta |
|---|---|---|---|
| `46a0c3b6` | `identity_personal.carta_identita` | «CAMPO COGNOME DA INSERIRE E DA DISTINGUERE DA CAMPO NOME» | campo che non esiste |
| `eeba7565` | `identity_personal.permesso_di_soggiorno` | «non riconosce documenti in orizzontale, aggiungere campo cognome distinto da nome» | campo che non esiste + OCR |
| `3a751fb8` | `accounting.fattura` | «distinguere partita iva da codice fiscale […] distinguere fatture emesse da fatture ricevute» | campo che non esiste + direzione |
| `b4bde437` | `accounting.fattura` | «aggiungere modalità di pagamento» | campo nell'ontologia, non nel profilo |
| `34efda4c` | *(nessuno)* | «FATTURA EMESSA, DA DISTINGUERE FATTURA RICEVUTA» | direzione |
| `b3e1f2c7` | `corporate_registry.visura_camerale` | «due campi uno per codice fiscale uno per partita iva» | campo che non esiste |
| `b26fd6a7` | `corporate_registry.visura_camerale` | «codice fiscale […] corrisponde al nr. registro delle imprese» | campo che non esiste |
| `b732d90f` | `corporate_registry.visura_camerale` | «data dichiarazione deve essere data documento» | campo sbagliato nel profilo |
| `33ffaf82` | `banking.ricevuta_bonifico` | «DATA INSERIMENTO, DATA ESECUZIONE, DATA VALUTA, NUMERO RAPPORTO/CONTO DA CUI PARTE» | campi che non esistono |
| `e017c573` | `procurement.preventivo` | «servirebbe un campo per i dati del cliente da salvare in anagrafica […] ho lasciato classe sales customer» | anagrafica + direzione |
| `fdff53df` | `insurance.certificato_assicurativo` | «prodotto assicurativo aggiunto» | già fatto dalla mappa |
| `6ad7d267` | `hse_training.attestato_formazione_generale` | «la scadenza è da calcolare in base alla normativa vigente […] a volte sono due attestati a volte è unico» | campo calcolato + tassonomia |
| `d7f6616d` | `certifications_licenses.autorizzazione_amministrativa` | «CONCESSIONE OCCUPAZIONE SUOLO PUBBLICO, DOVREMO CAPIRE COME GESTIRLE» | tassonomia |

### Il revisore ha già usato la mappa, e il dataset lo dice

Nel dataset ogni campo di ogni documento porta il suo `role`
(`required`/`core`/`optional`/`conditional`). È la mappa del tipo **com'era quando il
documento è stato elaborato**: registry più le correzioni del revisore. Un campo che il
registry chiede e che nel documento non c'è è stato tolto dalla mappa. Un campo che il
registry non chiede e che c'è è stato aggiunto. Il confronto è con il registry della 1.5.1
(`8642f96`), l'app che ha fatto l'export. Contano solo i documenti elaborati dopo il 17/09
alle 12:15, quando la mappa è entrata nell'app (`5d5afcd`), e con un tipo (i documenti con
`role` vuoto sono stati elaborati senza tipo e non dicono niente sulla mappa).

`praticaai-regole-apprese` non c'entra: le sue `actions` sono quelle del learner
(`LearningAction`), non della mappa.

Le decisioni che riguardano questo piano:

| Tipo | Aggiunti | Tolti | Cambiati di peso |
|---|---|---|---|
| `identity_personal.carta_identita` (18/09) | `identity.nationality` (required), `person.address` (core) | `identity.document_type`, `identity.document_number`, `identity.issue_date`\*, `issuer.name`, `recipient.name` | `document.number`, `document.issue_date` → required |
| `identity_personal.permesso_di_soggiorno` (18/09) | — | `document.issue_date`, `issuer.name`, `recipient.name` | `document.number` → required, `identity.document_number` → optional |
| `corporate_registry.visura_camerale` (18/09) | `recipient.tax_id` (core) | `document.number`, `recipient.name`, `product.name`, `product.composition`, `product.certifications`, `environment.criteria` | — |
| `insurance.certificato_assicurativo` (17/09) | `insurance.product` (required) | — | `insurance.vehicle_plate` → optional |
| `procurement.preventivo` (18/09) | `sales.customer`, `contract.payment_terms` (core) | — | — |
| `banking.ricevuta_bonifico` (17/09) | — | `utility.account_id` | — |
| `accounting.fattura` | — | — | — |

\* Sulla carta del 18/09 `identity.issue_date` non c'è più; su quella del 17/09 alle 13:41
c'era ancora, come optional.

Tre cose da qui:

- **Sulla visura, `recipient.tax_id` è una scelta della mappa.** Il revisore l'ha aggiunto
  come core per avere un posto dove scrivere il codice fiscale, dato che `company.tax_id`
  lo usa per la partita IVA. È la prova più forte che il campo manca.
- **Per carta e permesso il numero va in `document.number`**, promosso a required su
  entrambi. La data di rilascio invece non è coerente: `document.issue_date` sulla carta,
  `identity.issue_date` sul permesso.
- **La fattura non ha correzioni**: `payment.method`, chiesto dalla nota, non è stato
  aggiunto.

**Conseguenza:** quello che l'ontologia ha già si aggiunge dalla mappa, senza PR. Le PR
servono per quello che la mappa non sa fare: chiavi nuove, campi calcolati, la
direzione di un documento.

### Cosa dice l'ontologia oggi

- `issuer.tax_id`, `recipient.tax_id`, `company.tax_id` si chiamano **«CF/P.IVA …»**: un
  campo solo per due identificativi. `tax_id_format` accetta l'uno e l'altro.
- `company.registration_number` si chiama **«Numero REA/registro imprese»**: un campo per
  due numeri. Sulla visura `b26fd6a7` il revisore ci ha scritto `RO - 160649`, che è il REA.
- `person.name` è **«Nome persona»**, senza cognome distinto. È su 32 profili.
- Il bonifico ha `finance.transaction_date` («Data operazione»), `payment.date`,
  `bank.iban`, `bank.account_number`. Non c'è data valuta, e nessun campo dice di chi è
  l'IBAN.
- `hse.training_expiry` è su 12 profili come campo da **leggere**.
- Nessun campo e nessuna impostazione dice di chi sono i documenti: emessa e ricevuta non
  si possono distinguere.

### I segni che il campo manca

Sulle visure `b3e1f2c7` e `b26fd6a7` il revisore ha messo la partita IVA in
`company.tax_id` e il codice fiscale in `recipient.tax_id`: un destinatario che su una
visura non ha senso, aggiunto alla mappa perché non c'era un altro posto. Sulla carta
d'identità la data di rilascio sta in `document.issue_date`, sul permesso in
`identity.issue_date`: il registry chiede entrambe le chiavi, e la mappa ne ha tenuta una
diversa per ciascun tipo.

---

## Prima delle PR: cosa si fa dalla mappa

Nessun codice. Il revisore, dalla mappa del tipo:

- **`accounting.fattura`**: aggiungere `payment.method` («Metodo pagamento»). È la nota di
  `b4bde437`, e il campo c'è già nell'ontologia con le sue etichette.
- **`corporate_registry.visura_camerale`**: togliere `document.declaration_date`. I campi
  di prodotto (`product.*`, `environment.criteria`) li ha già tolti il 18/09; la data
  dichiarazione è rimasta, e la nota di `b732d90f` dice che è la data del documento, che
  `document.issue_date` già chiede.
- **Preventivo**: `sales.customer` è già nella mappa ma su `e017c573` è rimasto vuoto. La
  nota chiede più di un nome (dati da riconciliare in anagrafica): lo copre la PR 1 per
  gli identificativi e la PR 5 per la direzione.

Le correzioni della mappa restano nel database del revisore e arrivano a pratica-ai con
il pacchetto della mappa corretta. Le PR qui sotto cambiano il registry del repo, che vale
per tutti: dove il revisore ha già deciso, la PR segue la sua decisione.

---

## La sequenza

Ogni PR che tocca il registry segue il precedente di `accounting.nota_di_credito`: la
divergenza dal pack si scrive in `SNAPSHOT.txt`, e `extraction_schemas_v2.generated.json`
si allinea sugli stessi campi. I campi nuovi nascono nell'ontologia (etichetta, alias,
validatori) e in `extraction_hints_v2.json` (etichette che il lettore cerca), poi entrano
nei profili dei tipi che li hanno chiesti. Gli altri tipi non si toccano: li aggiunge il
revisore dalla mappa quando servono.

### PR 1 — Codice fiscale, partita IVA e REA in campi distinti ✅

Per fattura e visura, dove le note l'hanno chiesto e dove il revisore ha dovuto
arrangiarsi.

- Ontologia: `issuer.vat_number`, `recipient.vat_number`, `company.vat_number` («Partita
  IVA …»); `issuer.tax_code`, `recipient.tax_code`, `company.tax_code` («Codice fiscale …»);
  `company.rea_number` («Numero REA»). Stessa forma degli altri campi: `pii` come i
  `*.tax_id` che sostituiscono, `label_aliases_it` vuoto come tutti gli altri 248, le
  etichette negli hint.
- Validatori: il codice fiscale usa `italian_tax_code_format`, che accetta le due forme
  (16 caratteri per una persona, 11 cifre per una società). La partita IVA ha
  `vat_number_format`, che accetta **solo** le 11 cifre (`IT` davanti tolto) con la cifra
  di controllo: `INVALID_VAT_FORMAT` / `INVALID_VAT_CHECKSUM`, coi messaggi per la scheda.
  È dichiarato anche in `validators_v2.json`, e il test che controlla che ogni validatore
  del registry sia eseguibile lo copre.
- Profili: su `accounting.fattura` i due `*.tax_id` lasciano il posto a `*.vat_number` e
  `*.tax_code`; su `corporate_registry.visura_camerale` `company.tax_id` e
  `company.registration_number` lasciano il posto a `company.vat_number`,
  `company.tax_code` e `company.rea_number`. Tutti `core`, come i campi che sostituiscono;
  provenienza `REVIEWER_ANNOTATIONS`. Il numero del Registro Imprese coincide con il
  codice fiscale dell'impresa (lo dice la nota di `b26fd6a7`): non serve un campo suo. I
  profili passano a `2.0.2`: al primo avvio i documenti ancora da revisionare si
  rielaborano, e una correzione già scritta su `*.tax_id` resta, come campo fuori profilo.
- Etichette: «Partita IVA», «P.IVA», «P. IVA»; «Codice fiscale», «C.F.», «Cod. Fisc.»;
  «REA», «Numero REA», «N. REA». Sulla visura il codice fiscale compare come «Codice
  fiscale e numero di iscrizione» (così nelle evidenze dell'export) o «Codice fiscale e n.
  iscrizione al Registro Imprese»: tutte e due sono etichette di `company.tax_code`, e
  essendo più lunghe battono il «Codice fiscale» degli amministratori.

Quello che l'implementazione ha scoperto, e il piano non diceva:

- **Il REA non si leggeva.** Il lettore degli identificativi si ferma allo spazio, e
  «RO - 160649» dava `RO`, senza cifre, quindi niente. `company.rea_number` ha un formato
  suo (`rea_number`): sigla della provincia e numero, scritti `RO - 160649` come li
  trascrive il revisore, o il numero da solo; una data dopo l'etichetta («Data iscrizione
  REA 12/03/2010») non è un REA.
- **«C.F. e P.IVA 01234567890» su una riga.** Per il lettore la stessa riga con lo stesso
  valore appartiene a un campo solo, quello con l'etichetta più lunga: il codice fiscale
  restava vuoto. Partita IVA e codice fiscale della stessa parte ora possono prendere lo
  stesso valore dalla stessa riga, senza conflitto (`fiscalTwinOf`). La partita IVA si
  legge solo come 11 cifre: su «C.F./P.IVA: RSSMRA80A01H501U» resta vuota.
- **Emittente o destinatario, l'etichetta non lo dice.** Le etichette sono le stesse per
  le tre parti, e sulla fattura una «P.IVA» la leggono sia `issuer.*` sia `recipient.*`:
  vanno in `CONFLICT` con lo stesso valore, e il revisore sceglie. È il comportamento di
  sempre del lettore quando due campi hanno la stessa etichetta, ma sulle fatture sarà la
  regola, non l'eccezione. Distinguere le parti vuol dire leggere la posizione o il blocco
  (cedente/cessionario), non un'etichetta: fuori da questa PR, e la PR 5 ne dipende.
- **La mappa legacy non cambia.** `tax_code` → `company.tax_id` porta il campo v1 «Codice
  fiscale o partita IVA», che era l'uno o l'altro: `tax_id` è ancora la traduzione giusta,
  e la usano la migrazione 0004 sui dati vecchi, i profili `LEGACY_FALLBACK` e le etichette
  v1 di `company.tax_id` sugli 84 tipi che lo chiedono. `relations_v2.json` lega il
  documento a `issuer` e `recipient` come parti, non a un campo: vale anche per le chiavi
  nuove.

**Perché chiavi nuove e non `*.tax_id` ristretto alla partita IVA:** `company.tax_id` è su
84 profili, `issuer.tax_id` e `recipient.tax_id` su 22. Cambiarne il significato
cambierebbe tutti quei tipi e i valori già revisionati, dove il codice fiscale sta
legittimamente in `tax_id`. Con chiavi nuove il pack resta com'è, e i documenti vecchi
restano leggibili con le chiavi di allora: una fattura revisionata con `issuer.tax_id` si
valida ancora con `tax_id_format`.

Dopo il merge, il revisore toglie `recipient.tax_id` dalla mappa della visura. Verificato:
la mappa si somma al registry (`applyOverlay`), e il ripiego resta accanto a
`company.tax_code` finché non lo toglie. Lo stesso vale per qualunque decisione su un
campo uscito dal profilo: se il revisore gli aveva dato un peso, il campo rientra con quel
peso. Il pacchetto della mappa corretta esporta le chiavi nuove con la loro forma negli
schemi (`vat_number_format`, `italian_tax_code_format`), senza segnalarle fra i campi
fuori ontologia.

Resta da verificare: che pratica-ai accetti chiavi che il pack non ha. Arrivano con
`extraction_schemas_v2.json` del pacchetto della mappa, ma chi le consuma deve saperle
leggere.

### PR 2 — Cognome e nome distinti sui documenti d'identità ✅

- Ontologia: `person.last_name` («Cognome»), `person.first_name` («Nome»), `pii`
  `personal` come `person.name`. `person.name` resta, come «Nome e cognome», per i 28 tipi
  dove una persona compare per intero; il nuovo nome è anche un'etichetta in più per il
  lettore, su quei tipi.
- Profili (`2.0.3`): su `carta_identita`, `permesso_di_soggiorno`, `passaporto`,
  `patente_di_guida` `person.last_name` e `person.first_name` entrano required, e
  `person.name` esce. Numero, rilascio e scadenza stanno sulle chiavi generiche
  `document.number`, `document.issue_date`, `document.expiry_date`, required (deciso il
  19/09): sono le chiavi di fatture, visure e DURC, e hanno già i validatori (`non_empty`,
  `valid_date`). Escono `identity.document_number`, `identity.issue_date`,
  `identity.expiry_date`, `issuer.name` e `recipient.name`; di `identity.*` restano
  `identity.document_type` (core) e `identity.issuing_authority` (optional), che non hanno
  un corrispettivo generico. Provenienza `REVIEWER_ANNOTATIONS` per i campi entrati o
  ripesati.
- Cittadinanza e residenza, tipo per tipo:
  - carta e permesso: `identity.nationality` required e `person.address` core, come nella
    mappa della carta;
  - passaporto: `identity.nationality` required (la stampa sempre), `person.address`
    optional (il passaporto italiano ha la residenza, molti stranieri no);
  - patente: nessuno dei due. La patente europea non stampa la cittadinanza, e la
    residenza non sta sulla tessera: un cambio arriva col tagliando sul retro. Il revisore
    li aggiunge dalla mappa se servono.
- `identity.issue_date` e `identity.expiry_date` restano su `certificato_nascita`,
  `certificato_residenza`, `codice_fiscale`, `stato_di_famiglia`: prendono `valid_date`
  (sotto, «Un valore nel campo sbagliato»).
- Etichette: «Cognome», «Surname», «Nom»; «Nome», «Name», «Prénom», «Prénoms», «Given
  names». I documenti già revisionati (due carte, un permesso) tengono i valori sotto le
  chiavi di allora: nessuna migrazione.

Quello che l'implementazione ha scoperto, e il piano non diceva:

- **«Nome» dentro «Cognome» non è il rischio.** Il lettore cerca le etichette a confini di
  parola, e il testo libero vuole l'etichetta in testa al segmento: basta una delle due
  regole, e un test cade solo senza entrambe. Anche «COGNOME, NOME DEI GENITORI…» sul retro
  della carta e «Cognome e nome: ROSSI MARIO» non danno niente a nessuno dei due campi.
- **Il rischio vero era l'etichetta bilingue.** Sulla carta elettronica l'etichetta è
  «COGNOME / SURNAME» e il valore sta sotto. Con la sola «Cognome», la riga non finisce
  con l'etichetta e il lettore non guarda sotto: il campo restava vuoto. Negli hint ci
  sono anche «Cognome/Surname», «Nome/Name», «Indirizzo di residenza/Residence».
- **Una riga-etichetta non è un valore.** Se l'OCR perde il cognome, sotto «COGNOME /
  SURNAME» c'è «NOME / NAME», e il lettore la prendeva per il cognome. Ora una riga che è
  soltanto l'etichetta di un campo del profilo non è il valore di nessuno: il cognome
  resta vuoto. La regola vale per tutti i tipi, e nessun test esistente è cambiato.
- **Le chiavi generiche non avevano le etichette di `identity.*`.** `document.expiry_date`
  si cercava con «Data scadenza», non con «Scadenza»; `document.issue_date` non aveva
  «Data rilascio». Spostare i campi senza le etichette sarebbe stata una perdita: ora le
  hanno, per tutti i tipi che le chiedono, e sul permesso «Nazionalità» si legge.
- **Il `pii` è del campo, e le chiavi generiche sono `none`.** `identity.document_number`
  e le date di `identity.*` sono `pii: sensitive`, `document.*` `pii: none`: senza altro,
  lo schema esportato avrebbe detto `none` per il numero di una carta d'identità, ed è
  quello che pratica-ai riceve (`x-praticaai-pii`). Il profilo di un tipo ora può
  cambiare il `pii` di un campo, `field_pii_overrides`, come fa coi validatori
  (`field_validator_overrides`). Sui quattro documenti d'identità `document.number`,
  `document.issue_date` e `document.expiry_date` sono `sensitive`; sulla fattura e sugli
  altri tipi restano `none`. Un campo segnato non utile porta via la sua eccezione, come
  per i validatori.

Non si legge ancora, e resta fuori:

- **Valore accanto all'etichetta senza i due punti** («COGNOME / SURNAME ROSSI», «Cognome
  ROSSI» sulla carta cartacea): il testo libero vuole i due punti sulla stessa riga, per
  tutti i campi. Il campo resta vuoto, non sbagliato.
- **Due etichette affiancate** («EMISSIONE / ISSUING SCADENZA / EXPIRY», con le due date
  sotto): il lettore non sa in che colonna sta il valore. La scadenza resta vuota invece
  di prendere la data di emissione, per questo non c'è un'etichetta «Scadenza/Expiry».
- **Il passaporto** scrive «Cognome/Surname/Nom (1)»: il numero del campo dopo
  l'etichetta ferma la lettura sulla riga sotto. **La patente** non ha etichette, solo
  numeri («1.», «2.»). Su tutti e due il revisore scrive cognome e nome a mano, come
  faceva col nome intero; le etichette imparate dalle revisioni restano la strada.
- **La zona a lettura ottica** (MRZ) della carta e del passaporto porta cognome e nome
  separati da `<<`: un lettore suo, non un'etichetta.

Le righe dei test sono ricostruite sul modello della carta elettronica e del permesso,
non prese dai file: l'export non porta il testo delle pagine.

#### Dopo il merge, nella mappa

La mappa si somma al registry (`applyOverlay`): una decisione del revisore su un campo
uscito dal profilo lo rimette dentro col suo peso, e un'esclusione resta un'esclusione
(verificato in `tests/extract-v2-profile-loader.test.ts`, con le decisioni che l'export
del 18/09 fa vedere). Cosa vedrà il revisore, e cosa ripristinare (**Ripristina** sulla
scheda del campo, o sulla lista «Segnati non utili»):

- **Carta d'identità.** Tornano `person.name` (required) accanto a cognome e nome, e
  `identity.expiry_date` (required) accanto a `document.expiry_date`: il motore cerca
  tutti e quattro, e la scheda li chiede tutti. Ripristinare `person.name` e
  `identity.expiry_date`, che escono dalla mappa. `identity.document_type` resta escluso,
  perché è una decisione sua: il registry lo tiene core. Le decisioni uguali al registry
  nuovo (`identity.nationality` required, `person.address` core, `document.number` e
  `document.issue_date` required) non cambiano niente, e si possono ripristinare per
  pulizia. Le esclusioni su `identity.document_number`, `identity.issue_date`,
  `issuer.name`, `recipient.name` non hanno più effetto. Nascita e luogo di nascita
  required restano sue decisioni: il registry li tiene core.
- **Permesso di soggiorno.** Tornano `person.name` e `identity.expiry_date` (required) e
  `identity.document_number` (optional): ripristinarli. E soprattutto: **ripristinare
  `document.issue_date` fra i «Segnati non utili»**. Il revisore l'aveva escluso perché
  usava `identity.issue_date`, che ora esce dal registry: senza ripristino il permesso
  resta senza data di rilascio.
- Passaporto e patente non hanno decisioni nell'export.

Sui documenti già revisionati `person.name`, `identity.expiry_date`,
`identity.document_number` e `identity.issue_date` hanno un valore: una volta fuori dalla
mappa compaiono fra i «Compilati a mano, fuori dalla mappa» (`identity.issue_date` del
permesso subito, gli altri dopo il ripristino). Non vanno riaggiunti: il dato ora sta
nei campi nuovi.

Fuori da questa PR: «non riconosce documenti in orizzontale» (`eeba7565`). È
l'orientamento della pagina prima dell'OCR, non un campo: va misurato su quel file e
trattato a parte.

### PR 3 — Date e conto di un bonifico ✅

- Ontologia: `payment.entry_date` («Data inserimento»), `payment.execution_date` («Data
  esecuzione»), `payment.value_date` («Data valuta»), con `valid_date`;
  `payment.debit_account` («Conto di addebito»), senza `iban_checksum`, perché la nota
  dice «numero rapporto/conto» e un numero di rapporto non è un IBAN.
- Profilo `banking.ricevuta_bonifico` (`2.0.4`): i quattro campi entrano come core,
  provenienza `REVIEWER_ANNOTATIONS`; `finance.transaction_date` esce, perché «Data
  operazione» su una ricevuta vuol dire una di quelle tre, e il revisore l'ha usata per
  la data di esecuzione. Esce anche `utility.account_id`, che il revisore ha già tolto
  dalla mappa.
- `bank.iban` resta, ed è l'IBAN del beneficiario. Va scritto nella descrizione del
  campo su questo tipo, non cambiato nell'ontologia: `bank.iban` è su 40 tipi bancari.
- Etichette: «Data inserimento», «Data di inserimento», «Data e ora inserimento»; «Data
  esecuzione», «Data di esecuzione», «Eseguito il»; «Data valuta», «Data di valuta»,
  «Valuta beneficiario»; «Conto di addebito», «Conto addebito», «Numero rapporto»,
  «Rapporto», «Conto ordinante», «IBAN ordinante».

Solo `banking.ricevuta_bonifico`, il tipo della nota. `banking.disposizione_bonifico` e
`payments_treasury.distinta_bonifici` (due distinte nell'export, senza note) sono lo
stesso gesto visto da un altro documento: una volta che i campi sono nell'ontologia, il
revisore li aggiunge dalla mappa se servono, senza un'altra PR.

Quello che l'implementazione ha scoperto, e il piano non diceva:

- **La descrizione di un campo non esisteva.** Le 257 descrizioni del pack ripetono
  l'etichetta, e non c'era un posto dove scrivere che *su questo tipo* l'IBAN è del
  beneficiario. Il profilo ora può dirlo, `field_description_overrides`, come fa col
  `pii` (`field_pii_overrides`) e coi validatori: vale solo per i campi del profilo, e
  il revisore la legge sulla scheda del campo nella mappa del tipo. Non esce negli
  schemi, che non hanno descrizioni, ma esce nel profilo del pacchetto della mappa
  corretta. Un campo segnato non utile porta via la sua descrizione, come per gli altri.
- **Un IBAN a gruppi di quattro diventava `IT60`.** Il lettore degli identificativi si
  ferma allo spazio. `payment.debit_account` ha un formato suo (`account_number`): se la
  riga ha la forma di un IBAN lo legge intero, anche spaziato, altrimenti vale la
  lettura per token, che è quella giusta per «Numero rapporto: 000012345678».
- **«IBAN ordinante» mandava in conflitto «IBAN».** Due righe con la stessa etichetta e
  due valori diversi sono un conflitto, e sulla ricevuta l'IBAN del beneficiario finiva
  in `CONFLICT` con quello dell'ordinante — proprio il caso che questi campi servono a
  distinguere. Ora una riga già presa da un campo con l'etichetta più specifica non è
  nemmeno un secondo candidato per un altro: il documento ha detto di chi è. La regola
  vale per tutti i tipi, e nessun test esistente è cambiato.

Le righe dei test sono ricostruite sul modello di una ricevuta di bonifico online, non
prese dai file: l'export non porta il testo delle pagine.

#### Dopo il merge, nella mappa

Sul bonifico l'export del 18/09 ha una sola decisione, l'esclusione di
`utility.account_id`, che ora dice quello che dice già il registry e non ha più effetto.
`finance.transaction_date` esce dal registry: se un documento già revisionato ci ha un
valore, compare fra i «Compilati a mano, fuori dalla mappa» e non va riaggiunto, perché
il dato ora sta in `payment.execution_date`.

### PR 4 — La scadenza della formazione si calcola ✅

Oggi `hse.training_expiry` è un campo da leggere. Un attestato di solito non la scrive:
la scadenza dipende dal corso e dalla normativa. Il revisore ha scritto `13-05-2026` per
un attestato del 13/05/2021, cioè cinque anni dopo.

- Una tabella `corso → validità in anni` (`src/shared/training-expiry.ts`, modulo puro),
  con la data da cui si parte: rilascio dell'attestato o fine del corso. Nell'esempio il
  revisore è partito dal rilascio (13/05), non dall'ultima giornata (04/05).
- Il motore propone la scadenza quando il documento non la scrive e il corso è nella
  tabella. Una scadenza scritta sul documento vince sempre.
- Il dataset dice che il valore è calcolato: `origin` ha un terzo valore, `COMPUTED`,
  e `DATASET_FORMAT_VERSION` passa a `1.8.0`. Senza, una scadenza dedotta si misurerebbe
  come una letta.

La tabella non si scrive a memoria. L'unico dato che l'export conferma sono i cinque anni
della formazione lavoratori: la PR parte con quella riga sola, su
`hse_training.attestato_formazione_generale` e `attestato_formazione_specifica`. Gli
altri corsi (preposto, antincendio, primo soccorso, lavori in quota, spazi confinati, DPI
di terza categoria, RLS) non hanno una scadenza calcolata finché qualcuno che conosce la
normativa in vigore non scrive la riga, con il riferimento accanto. La PR lascia il posto
e dice come aggiungerla.

Quello che l'implementazione ha scoperto, e il piano non diceva:

- **Un valore dedotto non è solo un'origine nel dataset.** Fino a qui «proposto» e
  «letto» erano la stessa cosa, e l'evidenza lo dimostrava: campo pieno voleva dire riga
  verbatim del documento. Una scadenza calcolata rompe la coppia, e il flag serve lungo
  tutta la catena, non solo in fondo: `computed` sul fatto, sul campo e nel database
  (migrazione `0018`), o al primo salvataggio la deduzione sparisce e resta una data che
  sembra letta. Nel dataset diventa `origin: "COMPUTED"`; corretta dal revisore torna
  `REVIEWER`, come ogni altra proposta.
- **Il campo tornava vuoto appena salvato.** La pipeline scriveva il valore solo se il
  fatto aveva un'evidenza — regola giusta fino a ieri, ma un valore dedotto non ne ha
  nessuna, e finiva a `null` fra la lettura e il database.
- **Il revisore doveva poterlo distinguere a colpo d'occhio.** Una data senza evidenza e
  senza altro sembra una lettura andata male. Sulla scheda ora c'è la pillola «dedotto»,
  la confidence è 0,60 — sotto la soglia di accettazione automatica — e lo stato è
  `NEEDS_REVIEW`: il motore la propone, non l'afferma.
- **«N campi con evidenza verbatim» sarebbe diventata falsa.** L'evento
  dell'elaborazione conta i letti e elenca i dedotti a parte.
- **Un obbligatorio dedotto non è più mancante.** `hse.training_expiry` oggi è core
  dappertutto, ma se un profilo lo chiedesse required il run avrebbe segnalato «manca» un
  campo che ha un valore, chiedendo di cercare nel documento una data che il documento non
  ha.

Fuori da questa PR, alla tassonomia: generale e specifica a volte sono un attestato solo, a
volte due. Il revisore ha tenuto «formazione generale». Un campo `hse.training_course`
con più valori coprirebbe il caso senza un tipo nuovo.

E fuori da questa PR, all'ontologia: `hse.training_expiry` ha `evidence_required: true`,
come tutti e 257 i campi del pack. Un valore dedotto non ce l'ha, e il flag esce così
com'è negli schemi (`x-praticaai-evidence-required`). Non è una bugia sul campo — quando
l'estrazione lo legge, l'evidenza la vuole — ma chi consuma gli schemi va avvisato che
`COMPUTED` esiste.

### PR 5 — Emessa o ricevuta ✅

Non è un dato del documento: la stessa fattura è emessa per chi la scrive e ricevuta per
chi la paga. Si ricava confrontando l'emittente con l'azienda di cui sono i documenti.

- Un'impostazione: ragione sociale, partita IVA e codice fiscale dell'azienda
  (`company_identity`, migrazione `0019`, nella dashboard). Il nome non era nel piano:
  serve al preventivo, che nel profilo non ha nessun campo fiscale.
- Un attributo del documento, non un campo estratto: `EMESSO` se l'emittente è
  l'azienda, `RICEVUTO` se lo è il destinatario, vuoto se non è nessuno dei due o se i
  campi mancano. Il revisore può correggerlo.
- Vale per fattura, nota di credito, proforma e preventivo: il preventivo `e017c573` è
  emesso da POLESINE MASSETTI, ed è il motivo per cui il revisore non sapeva se tenerlo
  in `procurement` o in `sales_customers`.
- Export: `direction` nel JSON e `direction`/`direction_chosen_by` nel foglio `documents`
  dell'xlsx, con `DATASET_FORMAT_VERSION` a `1.9.0`.

Dipende dalla PR 1: il confronto è affidabile solo quando partita IVA e codice fiscale
stanno in campi diversi. Nell'export tutte e tre le fatture hanno come emittente
POLESINE MASSETTI SRLS (01479320291), quindi sono tutte emesse.

Quello che l'implementazione ha scoperto, e il piano non diceva:

- **La direzione non si salva.** Il piano la chiamava un attributo del documento, e la
  cosa naturale sarebbe stata calcolarla all'elaborazione e scriverla. Ma dipende da
  un'impostazione che si può cambiare, e dai valori che il revisore sta ancora
  correggendo: salvata, sarebbe stata vecchia il giorno dopo. Si ricalcola a ogni lettura
  (`@shared/document-direction`), e del revisore resta solo la scelta, quando ne fa una
  (`documents.direction_choice`). Così la scheda si aggiorna mentre lui compila i campi.
- **Il conflitto della PR 1 si risolve da sé.** La domanda che il piano lasciava aperta —
  se calcolare la direzione su un valore ancora in `CONFLICT` — non aveva bisogno di una
  regola sua: una «P.IVA» che l'etichetta non attribuisce finisce sulle due parti **con
  lo stesso valore**, e l'azienda trovata da tutte e due non decide niente. Scartare a
  priori i campi in conflitto sarebbe stato peggio: il revisore ne risolve uno e lascia
  l'altro comʼè, quel campo resta segnato in conflitto per sempre, e la direzione non si
  sarebbe più ricavata nemmeno a documento chiuso.
- **Senza il nome dell'azienda il preventivo era fuori.** `procurement.preventivo` non ha
  nessun campo fiscale in profilo, solo `issuer.name` e `recipient.name`: con la sola
  partita IVA la sua direzione sarebbe stata sempre vuota, cioè proprio il documento da
  cui la nota parte. Il confronto sul nome viene dopo gli identificativi e ignora
  maiuscole, punteggiatura e forma societaria.
- **«Né l'uno né l'altro» è una decisione.** Un documento fra due terzi non è emesso né
  ricevuto, e lasciarlo vuoto non si distinguerebbe da «non calcolato». Nel dataset esce
  come `choice: "NESSUNA"` con `chosenBy: "REVIEWER"`.
- **Nel dataset escono tutti e due.** Il piano diceva «una proprietà»; ne esce un oggetto,
  col calcolo accanto alla scelta, come per il tipo del classificatore: è la differenza
  fra i due a dire se il calcolo funziona.

**Perché non due tipi `fattura_emessa` e `fattura_ricevuta`:** la tassonomia è del pack,
e la direzione dipende da chi guarda, non dal documento. Due tipi raddoppierebbero
classificatore e profili per un dato che si calcola.

Resta da verificare: che pratica-ai legga `direction`. La proprietà è nuova nel formato
`1.9.0`, e chi consuma il dataset deve saperla leggere o ignorarla senza rompersi.

---

## Cosa resta aperto

- **Cinque documenti revisionati senza tipo.** `34efda4c` (la fattura 642/2025, proposta
  `accounting.fattura` a 0,83), `1d231d1a`, `bf1ce705`, `327bc8d8`, `28236a53` sono
  `REVIEWED` con tipo finale `null`. Prima di dire che il revisore ha tolto il tipo,
  va verificato quando l'app ha cominciato a permetterlo e che cosa succede al tipo
  quando il documento si chiude. La nota della fattura fa pensare che mancasse il tipo
  giusto (emessa), ma non lo prova.
- **Concessione di occupazione del suolo pubblico** (`d7f6616d`). È finita in
  `autorizzazione_amministrativa` e il revisore chiede come gestirla. Tipo nuovo o
  sottotipo, e con quali campi (luogo, superficie, periodo), è una domanda di
  tassonomia da fare a chi mantiene il pack.
- **`money.tax` con testo dentro.** Sulle tre fatture vale `0% - Rev. charge art.17`: una
  dicitura in un campo da importo. `non_negative_money` non la segnala, perché un testo
  non è un numero negativo. Serve un campo per la natura IVA (reverse charge, esenzione)
  e l'importo a 0.
- **La colonna `document_type_predicted` dell'xlsx.** `src/shared/dataset-xlsx.ts:136`
  ci mette il tipo **finale** quando c'è una confidence, e niente quando il revisore ha
  corretto il tipo. La proposta vera del classificatore sta solo nel JSON
  (`documentType.proposed`). È una correzione piccola, fuori da questa sequenza.
- **Un valore nel campo sbagliato.** Sulla carta d'identità `46a0c3b6`
  `identity.expiry_date` vale `COMUNE DI ROVIGO`. Nessuno poteva segnalarlo: la scheda
  valida quello che si vede solo dal 19/09 (`eaf310a`), e le date di `identity.*`
  (`issue_date`, `expiry_date`) non avevano validatori. Chiuso nella PR 2: hanno
  `valid_date`, e la carta del 18/09 mostra l'avviso sotto la chiave di allora.
