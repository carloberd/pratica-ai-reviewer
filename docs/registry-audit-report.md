# I buchi che `registry-audit.mjs` contava, e quelli che restano

Il registry v3.0.0 — 454 campi, 171 tipi di documento — è il punto di verità
dell'estrazione: da qui si costruirà il template con cui un modello legge ogni
documento. `node scripts/registry-audit.mjs` conta nove buchi che rendevano quella
conversione impossibile o ambigua. Questo è il rapporto di cosa si è chiuso, come, e
cosa resta da decidere.

La regola che ha guidato il lavoro: **non si inventa niente che descriva un documento**.
Dove il materiale del registry non bastava, il campo è rimasto com'è ed è finito negli
elenchi qui sotto. Sono le decisioni di Carlo, non dell'agente.

## I nove numeri, prima e dopo

| # | Buco | Prima | Dopo |
|---|------|------:|-----:|
| 1 | campi `object` senza schema di riga | 75 | **13** |
| 2 | campi senza alias di etichetta | 307 | **0** |
| 3 | attributi obbligatori che nessuno calcola | 29 | **0** |
| 4 | identificativi con un format che il lettore non conosce | 2 | **0** |
| 5 | percentuali senza convenzione di scala | 6 | **0** |
| 6 | valuta senza enum | 1 | **0** |
| 7 | etichette condivise da più campi | 8 | **0** |
| 8 | campi mai chiesti da un tipo | 50 | **28** |
| 9 | `evidence_required` sempre uguale | 454 | **0** |

I tipi convertibili in template passano da **31 a 147**; quelli fermi su almeno un campo
`object` senza colonne da **140 a 24**. I 12 invarianti restano a zero, e ne sono nati
altri nove sul formato nuovo (colonne con id unico, tipo del vocabolario ed etichetta;
enum senza valori vuoti o ripetuti; derivati sempre senza citazione e mai anche fra i
campi da leggere; scale che il lettore sa applicare).

---

## Da decidere: le colonne che la descrizione non fissa (buco 1)

62 campi `object` su 75 hanno le colonne della loro riga, lette dalla descrizione che le
elencava già («le righe contabili, con data, descrizione, dare e avere di ciascuna» →
`data`, `descrizione`, `dare`, `avere`).

Restano 13 dove la descrizione nomina l'elenco ma non quello che ogni voce porta. Per
ognuno serve sapere **cosa c'è in una riga**: un valore solo, o più colonne, e quali.

| campo | tipi che lo chiedono | descrizione |
|---|---:|---|
| `product.certifications` | 5 | Le certificazioni o le marcature del prodotto: CE, ATEX, marchi di conformità. |
| `contract.references` | 4 | Gli altri contratti o atti che questo richiama, modifica o proroga. |
| `procurement.selection_criteria` | 4 | I criteri di selezione richiesti o dichiarati: requisiti economici, tecnici, professionali. |
| `privacy.data_categories` | 3 | Quali categorie di dati sono trattate, comprese quelle particolari se ci sono. |
| `privacy.data_subjects` | 3 | Chi sono gli interessati: clienti, dipendenti, fornitori, candidati. |
| `environment.criteria` | 2 | I criteri ambientali minimi o i requisiti a cui il documento dichiara conformità. |
| `hse.training_topics` | 2 | I contenuti del corso, come il programma li elenca. |
| `insurance.territorial_validity` | 2 | I paesi in cui la copertura vale, come il documento li elenca o li barra. |
| `maintenance.activities` | 2 | Le attività svolte durante l'intervento, come il rapporto le elenca. |
| `privacy.recipients` | 2 | A chi i dati sono comunicati o da chi sono trattati per conto del titolare. |
| `product.performance` | 2 | Le prestazioni del prodotto, come la scheda le dichiara. |
| `person.skills` | 1 | Le competenze dichiarate, così come il documento le elenca. |
| `sales.activities` | 1 | Le attività svolte durante l'intervento, come il rapportino le elenca. |

Due casi ricorrono, e forse basta una decisione per gruppo:

- **la descrizione dà esempi, non colonne** (`product.certifications`,
  `privacy.data_subjects`, `procurement.selection_criteria`): «CE, ATEX» sono valori, non
  campi. Una colonna sola con il nome della cosa? O un enum?
- **la descrizione rimanda al documento** («come il programma li elenca»,
  `hse.training_topics`, `person.skills`, `maintenance.activities`, `sales.activities`,
  `product.performance`, `insurance.territorial_validity`): una riga di testo libero, o
  c'è una struttura che i documenti veri hanno e la descrizione non ha scritto?

Gli altri quattro hanno una domanda ciascuna: `contract.references` porta numero e data
come `document.references`? `privacy.data_categories` ha una colonna per «dati
particolari»? `privacy.recipients` distingue destinatario e ruolo? `environment.criteria`
è un elenco di criteri o criterio più esito?

## Da decidere: i 28 campi che nessun tipo chiede (buco 8)

Dei 50 campi che nessun tipo chiedeva, 22 hanno trovato una casa — e solo dove il
namespace del campo e il dominio del tipo dicono la stessa cosa. Non si è cancellato
niente: quella è una decisione fuori da questo lavoro.

I 28 che restano sono ontologia non verificata, e si dividono in quattro gruppi.

**Manca il tipo di documento (18).** Non c'è niente di sbagliato nei campi: non c'è la
classe che li porterebbe.

| gruppo | campi | il tipo che manca |
|---|---|---|
| finanziamenti | `finance.final_value`, `finance.installment_amount`, `finance.installments`, `finance.interest`, `finance.interest_rate`, `finance.principal`, `finance.product_type`, `finance.residual_principal`, `finance.taeg`, `finance.tan`, `finance.transaction_date`, `finance.transactions` | contratto di mutuo, leasing, finanziamento: nella mappa non c'è. `rentals.contratto_noleggio_operativo` è un'altra cosa — un noleggio operativo non ha riscatto |
| IT | `it.asset`, `it.findings`, `it.incident_date`, `it.recovery_target`, `it.severity`, `it.system` | non esiste una famiglia IT: nessun rapporto di incidente, nessun report di vulnerabilità |

**Manca il tipo dell'adeguata verifica (4).** `compliance.decision`,
`compliance.pep_status`, `compliance.relationship_purpose`, `compliance.source_of_funds`
sono i campi di un questionario KYC/antiriciclaggio. I due tipi «titolare effettivo» che
la mappa ha (`corporate_registry.comunicazione_titolare_effettivo`,
`pnrr_esg.dichiarazione_titolare_effettivo`) non li portano: sono comunicazioni al
registro, non adeguate verifiche.

**Direbbero quello che un campo accanto dice già (5).**

| campo | chi lo dice già |
|---|---|
| `hse.controls` | `assets_maintenance.registro_verifiche_periodiche` porta le sue righe in `line_items` |
| `money.net` | dove sta `money.gross` (cedolino, prospetto costo del personale) il netto è `payroll.net_pay` |
| `utility.period_start`, `utility.period_end` | `utilities_subscriptions.bolletta_utenza` ha già `period.start` e `period.end` |
| `environment.emissions` | nessun tipo della famiglia `environment` dichiara emissioni: registro rifiuti, FIR, RENTRI, SDS parlano d'altro |

**Manca il tipo della dichiarazione fiscale (1).** `tax.return_type` («730, Redditi PF,
IVA annuale, IRAP, 770») non ha una casa: la famiglia `fiscal_tax` ha avvisi, cartelle,
F24 e la certificazione unica, nessuna dichiarazione.

Per ognuno la domanda è la stessa: **arriva il tipo, o va via il campo?**

## Da decidere: gli alias su cui non si è sicuri (buco 2)

Tutti e 307 i campi hanno adesso almeno un alias, e i 45 che cinque o più tipi chiedono
ne hanno da due a cinque. Ogni alias è una variante con cui un documento italiano scrive
davvero quel campo. Questi però meritano un occhio.

**Etichette contese, assegnate a uno solo.** Quando due campi si contendevano la stessa
frase l'ha avuta uno, e la scelta è discutibile:

| frase | assegnata a | l'altro candidato |
|---|---|---|
| «Causale» | `payment.reference` | `bank.causal`, che ha «Causale ABI» |
| «Oggetto» | `communication.subject` | `contract.subject` («Oggetto del contratto»), `procurement.procedure_title` («Oggetto della gara») |
| «Modalità di pagamento» | `payment.method` | `contract.payment_terms` («Termini di pagamento») |
| «Trasportatore» | `environment.transporter` | `logistics.carrier`, che ha «Spedizioniere» |

**Alias larghi su campi larghi.** `document.deadline` («Scadenza operativa generale») ha
«Entro il»: è come i documenti la scrivono, ma prenderà anche righe che parlano d'altro.
Stesso dubbio per `money.amount` («Ammontare», «Somma»), che compete con `money.total` su
30 tipi. Se il falso positivo pesa più del campo vuoto, questi due alias vanno tolti.

**Formule, non etichette.** `person.name` ha «Il sottoscritto», che apre una
dichiarazione invece di etichettare un campo. Funziona sulle autocertificazioni, non
altrove.

**Alias che nessuno cercherà.** Gli 11 campi derivati (`document.direction`,
`counterparty.role`, `event_type`, …) hanno alias come gli altri, ma il lettore non li
cerca più: non stanno fra i campi da leggere di nessun tipo. Sono lì per coerenza del
formato, e si possono togliere senza perdere niente.

**Alias mai messi alla prova.** I 28 campi senza casa hanno alias scritti senza un
documento su cui verificarli: `finance.taeg` → «T.A.E.G.», `it.severity` → «Severità».
Se il campo va via, va via anche l'alias.

## Due cose viste strada facendo

- **`document.lifecycle_stage` non esiste.** `ATTRIBUTE_FIELDS` in
  `scripts/registry-audit.mjs` elenca 12 attributi, ma l'ontologia ne ha 11: quello non
  c'è. Nessun tipo lo chiede, quindi non rompeva niente, ma la lista dice una cosa che il
  registry non ha.
- **`pnpm benchmark:pilot` non misura.** Il benchmark del corpus pilota si salta: senza
  corpus il test passa senza aver confrontato niente. «Non è sceso rispetto a `main`» qui
  vuol dire solo «si è saltato prima e si salta adesso».

---

## AVANZAMENTO, prima

```
AVANZAMENTO — numeri da far scendere

     75  campi «object» senza schema di riga
         bloccano 140 tipi su 171: senza le colonne non esiste una conversione
         ⤷ document.references (in 73 tipi)
         ⤷ line_items (in 21 tipi)
         ⤷ contract.parties (in 17 tipi)
         ⤷ contract.obligations (in 11 tipi)
         ⤷ credit.invoice_refs (in 7 tipi)
         ⤷ procurement.items (in 7 tipi)
         ⤷ tax.vat_summary (in 7 tipi)
         ⤷ hse.preventive_measures (in 6 tipi)
         ⤷ …e altri 67

    307  campi senza nessun alias di etichetta
         il motore cerca solo la loro etichetta: un documento che la scrive diversamente lascia il campo vuoto
         ⤷ document.references — «Riferimenti ad altri documenti collegati» (in 73 tipi)
         ⤷ money.amount — «Importo» (in 30 tipi)
         ⤷ document.effective_date — «Data decorrenza» (in 25 tipi)
         ⤷ payment.due_date — «Scadenza pagamento» (in 22 tipi)
         ⤷ line_items — «Righe documento» (in 21 tipi)
         ⤷ employment.employee_name — «Lavoratore» (in 20 tipi)
         ⤷ employment.employee_tax_code — «CF lavoratore» (in 18 tipi)
         ⤷ contract.parties — «Parti contrattuali» (in 17 tipi)
         ⤷ …e altri 299

     29  attributi obbligatori che nessuno calcola
         non stanno scritti sul documento: finché non li deriva qualcuno, il campo resta vuoto e ogni documento di quel tipo va in revisione
         ⤷ accounting.fattura: counterparty.role
         ⤷ accounting.fattura: document.direction
         ⤷ accounting.fattura_proforma: counterparty.role
         ⤷ accounting.fattura_proforma: document.direction
         ⤷ accounting.nota_di_credito: counterparty.role
         ⤷ accounting.nota_di_credito: document.direction
         ⤷ accounting.nota_di_debito: counterparty.role
         ⤷ accounting.nota_di_debito: document.direction
         ⤷ …e altri 21

      2  identificativi con un format che il lettore non conosce
         si leggono per token come se non avessero format: il format c’è scritto ma non cambia niente
         ⤷ procurement.cig — «cig»
         ⤷ procurement.cup — «cup»

      6  percentuali senza convenzione di scala
         22 o 0,22? finché non sta scritto, metà dei documenti va in un modo e metà nell’altro
         ⤷ construction.progress_percent
         ⤷ finance.interest_rate
         ⤷ finance.taeg
         ⤷ finance.tan
         ⤷ invoice.withholding_rate
         ⤷ money.rate

      1  campi da enum lasciati stringa libera
         una valuta senza enum arriva scritta in tutti i modi in cui il documento la scrive
         ⤷ money.currency

      8  etichette condivise da più campi
         come chiavi di template sono ambigue: le distingue solo la descrizione
         ⤷ «Saldo contabile» → accounting.balance, bank.balance_accounting
         ⤷ «Data scadenza» → document.expiry_date, license.expiry_date
         ⤷ «Interessi» → finance.interest, tax.interest
         ⤷ «Tipo rischio» → hse.risk_type, risk_type
         ⤷ «Scadenza pagamento» → payment.due_date, utility.due_date
         ⤷ «Competenze» → payroll.earnings, person.skills
         ⤷ «Lotto» → procurement.lot, product.batch
         ⤷ «Proprietario» → realestate.owner, vehicle.owner

     50  campi dell’ontologia mai chiesti da un tipo
         o servono a tipi che non ci sono ancora, o vanno via: sono ontologia non verificata
         ⤷ bank.account_number
         ⤷ commercial.customer_reference
         ⤷ commercial.supplier_reference
         ⤷ compliance.decision
         ⤷ compliance.pep_status
         ⤷ compliance.relationship_purpose
         ⤷ compliance.source_of_funds
         ⤷ contract.duration
         ⤷ …e altri 42

    454  campi con «evidence_required» sempre uguale
         vale true su tutti: il campo non distingue niente

```

## AVANZAMENTO, dopo

```
AVANZAMENTO — numeri da far scendere

     13  campi «object» senza schema di riga
         bloccano 24 tipi su 171: senza le colonne non esiste una conversione
         ⤷ product.certifications (in 5 tipi)
         ⤷ contract.references (in 4 tipi)
         ⤷ procurement.selection_criteria (in 4 tipi)
         ⤷ privacy.data_categories (in 3 tipi)
         ⤷ privacy.data_subjects (in 3 tipi)
         ⤷ environment.criteria (in 2 tipi)
         ⤷ hse.training_topics (in 2 tipi)
         ⤷ insurance.territorial_validity (in 2 tipi)
         ⤷ …e altri 5

      0  campi senza nessun alias di etichetta
         il motore cerca solo la loro etichetta: un documento che la scrive diversamente lascia il campo vuoto

      0  attributi obbligatori che nessuno calcola
         non stanno scritti sul documento: finché non li deriva qualcuno, il campo resta vuoto e ogni documento di quel tipo va in revisione

      0  identificativi con un format che il lettore non conosce
         si leggono per token come se non avessero format: il format c’è scritto ma non cambia niente

      0  percentuali senza convenzione di scala
         22 o 0,22? finché non sta scritto, metà dei documenti va in un modo e metà nell’altro

      0  campi da enum lasciati stringa libera
         una valuta senza enum arriva scritta in tutti i modi in cui il documento la scrive

      0  etichette condivise da più campi
         come chiavi di template sono ambigue: le distingue solo la descrizione

     28  campi dell’ontologia mai chiesti da un tipo
         o servono a tipi che non ci sono ancora, o vanno via: sono ontologia non verificata
         ⤷ compliance.decision
         ⤷ compliance.pep_status
         ⤷ compliance.relationship_purpose
         ⤷ compliance.source_of_funds
         ⤷ environment.emissions
         ⤷ finance.final_value
         ⤷ finance.installment_amount
         ⤷ finance.installments
         ⤷ …e altri 20

      0  campi con «evidence_required» sempre uguale
         11 campi non chiedono una citazione: sono quelli che il motore calcola

```
