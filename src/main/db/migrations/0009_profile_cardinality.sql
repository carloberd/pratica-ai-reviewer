-- Quanti valori chiede un campo su un tipo: uno solo o più di uno.
--
-- L'ontologia dà a ogni campo una cardinalità di partenza (`default_cardinality`), la
-- stessa per tutti i tipi. Ma lo stesso dato può averne uno solo su un tipo e più d'uno su
-- un altro — un IBAN su una fattura, gli IBAN di un estratto conto — e il revisore lo
-- decide dalla scheda «Campi da estrarre», tipo per tipo, come il peso del campo.
--
-- Una tabella a parte e non una colonna di profile_overrides: il peso e la cardinalità
-- si decidono e si annullano ognuno per conto suo, e un campo può avere l'una senza
-- l'altro. Il campo assente da qui segue l'ontologia; una riga c'è solo quando la
-- decisione del revisore è diversa da quella.
CREATE TABLE profile_cardinality_overrides (
  document_type TEXT NOT NULL,
  field_id      TEXT NOT NULL,
  cardinality   TEXT NOT NULL CHECK (cardinality IN ('one', 'many')),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (document_type, field_id)
) WITHOUT ROWID;

-- La cronologia resta una: su profile_actions un'azione SET_CARDINALITY scrive in
-- before_state, after_state e previous_override «one» o «many» invece di un peso.
