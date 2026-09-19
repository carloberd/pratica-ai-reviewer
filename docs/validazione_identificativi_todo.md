# Validazione degli identificativi — IBAN, partita IVA, codice fiscale, targa, telaio

Obiettivo: un identificativo sbagliato si vede prima di finire nel dataset, che lo abbia
letto il motore o che lo abbia scritto chi rivede.

---

## Da dove si parte

`src/main/extract/v2/validators.ts` al 19/09/2026 (1.6.0):

- **IBAN**: checksum mod 97, cioè un controllo vero;
- **partita IVA e codice fiscale**: solo la forma. Undici cifre qualsiasi passavano, e un
  codice fiscale omocodico (lettere al posto delle cifre) veniva scartato anche se valido;
- **targa e telaio**: dichiarati in `validators_v2.json` come regex, ma quel file non si
  carica e nessun campo dell'ontologia li usava. `employment.employee_tax_code` non aveva
  validatori;
- **dove girano**: solo sui candidati del motore. Abbassano la confidence e mandano il
  campo in `NEEDS_REVIEW`; l'errore finisce in `validation_errors_json`, ma la UI non lo
  mostra. Quello che scrive o seleziona chi rivede non si valida.

L'export del 18/09 (43 documenti) ha 32 valori fra IBAN, partita IVA e codice fiscale.
Quelli del motore passano tutti il controllo; i quattro che non lo passano vengono tutti
dalla revisione: un'etichetta finita dentro l'IBAN, codice fiscale e partita IVA nello
stesso campo, un codice fiscale con una lettera letta come cifra, uno con due caratteri di
troppo. Non è un comportamento di chi rivede: l'app li ha accettati senza dire niente, e
un carattere di controllo li avrebbe segnalati tutti.

---

## La sequenza

### PR 1 — I controlli veri ✅

- Partita IVA con la cifra di controllo (Luhn), codice fiscale col carattere di controllo,
  omocodia compresa. Forma sbagliata e controllo sbagliato sono due errori distinti
  (`INVALID_TAX_ID_FORMAT` / `INVALID_TAX_ID_CHECKSUM`, `INVALID_CF_FORMAT` /
  `INVALID_CF_CHECKSUM`): dicono cose diverse a chi rivede.
- `IT` davanti alle 11 cifre è il prefisso comunitario, non parte del codice: lo toglie il
  validatore, e il lettore del motore ora legge `IT01234567890`, che prima perdeva.
- `vehicle_plate` e `vin` eseguiti come builtin, con le regex del pack; assegnati a
  `vehicle.plate`, `insurance.vehicle_plate`, `vehicle.vin`. `italian_tax_code_format` su
  `employment.employee_tax_code`. Divergenza dal pack annotata in `SNAPSHOT.txt`.
- Un test controlla che ogni validatore del registry sia uno che il modulo sa eseguire.

Resta fuori: se la partita IVA **esiste**. Servirebbe VIES o l'Agenzia delle Entrate, cioè
mandare i dati a un servizio esterno.

### PR 2 — Il valore che si vede si valida, e si vede che non va ✅

Un solo meccanismo per le due metà del problema: i validatori del campo (quelli
dell'ontologia, o quelli che il profilo del tipo mette al loro posto) girano sul valore
**corrente** — la correzione se c'è, altrimenti la proposta — quando la revisione legge i
campi, e la scheda mostra un avviso accanto al campo. Così:

- la proposta del motore con un validatore fallito dice perché è in revisione;
- quello che scrive o seleziona chi rivede si controlla subito, all'uscita dal campo;
- non serve una migrazione, e un validatore migliorato vale anche sui documenti già fatti.

L'avviso non blocca: un documento può riportare davvero un codice sbagliato, e il compito
è trascriverlo. Una partita IVA straniera non passa il controllo italiano.

Com'è fatta: `validateFieldValue` (in `validators.ts`) prende i validatori con
`validatorsOf`, la stessa funzione che ora usa il motore, e li fa girare con
`validationErrorsOf`, che su un valore vuoto non dice niente. Il repository la riceve come
dipendenza (`validateField`) e mette `validationErrors` sui campi e sulle righe di
`getReviewDocument`, tranne sulle righe tolte, che nel dataset non finiscono. La scheda
mostra il messaggio sotto il campo (`validation-note.tsx`, testi in
`@shared/validation-messages`) e lo nasconde mentre si scrive, perché riguarda il valore
salvato. Le PR 2 e 3 della proposta iniziale (validare quello che scrive chi rivede,
mostrare gli errori del motore) erano lo stesso meccanismo, e sono diventate una PR sola.

---

## Cosa resta aperto

- **L'export.** Il dataset non dice quali valori non passano i validatori. Chi lo usa per
  misurare l'estrazione li ricalcola da sé, oppure un campo `validationErrors` va aggiunto
  al formato, con la versione del formato da alzare.
- **Normalizzare quello che si salva.** Un identificativo scritto con gli spazi, o con
  l'etichetta dentro («IBAN: …»), ora si segnala ma si salva com'è. Toglierli in silenzio
  cambierebbe il valore trascritto: va deciso, non dato per scontato.
- **Se il codice esiste.** VIES per la partita IVA, l'Agenzia per il codice fiscale:
  servizi esterni, e i dati uscirebbero dalla macchina.
