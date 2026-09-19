-- Emessa o ricevuta: l'azienda di cui sono i documenti, e la scelta del revisore.
--
-- La direzione non è un dato del documento — la stessa fattura è emessa per chi la scrive
-- e ricevuta per chi la paga — e non è nemmeno un campo estratto: si ricava confrontando
-- le parti con l'azienda di cui sono i documenti. Quindi non si salva: si ricalcola a ogni
-- lettura da quello che il revisore ha confermato (`@shared/document-direction`), così
-- cambiare l'impostazione qui sotto non lascia in giro direzioni vecchie.
--
-- Di persistente restano due cose.

-- L'azienda, una riga sola. Vuota finché il revisore non la scrive: senza, la direzione
-- non si calcola su nessun documento, ed è giusto così — non c'è niente con cui
-- confrontare le parti.
--
-- Partita IVA e codice fiscale sono l'identificativo che decide; il nome serve ai tipi che
-- nel profilo non hanno nessun campo fiscale, come il preventivo, dove altrimenti la
-- direzione resterebbe sempre vuota.
CREATE TABLE company_identity (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  name         TEXT,
  vat_number   TEXT,
  tax_code     TEXT,
  updated_at   TEXT NOT NULL
);
INSERT INTO company_identity (id, name, vat_number, tax_code, updated_at)
  VALUES (1, NULL, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- La scelta del revisore, quando ne fa una: vince sul calcolo e non si ricalcola mai.
-- NULL vuol dire che non l'ha toccata, e allora vale quello che si ricava dal documento.
-- `NESSUNA` non è un buco: dice che l'ha guardata e non è né emesso né ricevuto.
ALTER TABLE documents ADD COLUMN direction_choice TEXT
  CHECK (direction_choice IS NULL OR direction_choice IN ('EMESSO', 'RICEVUTO', 'NESSUNA'));
