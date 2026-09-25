-- I ruoli della mappa passati da quattro a due, anche nelle decisioni già prese.
--
-- Fino al Brain MVP (`8966618`, 22/09/2026) i ruoli erano `required`, `core`, `optional`
-- e `conditional`, e il revisore poteva scriverli tutti e quattro su `profile_overrides`.
-- Da lì il codice ne conosce due, ma le righe scritte prima sono rimaste com'erano e il
-- CHECK di questa tabella (0008) continuava ad accettarle: nessuna migrazione le aveva
-- portate avanti.
--
-- Il conto lo pagava chiunque avesse corretto la mappa prima di quella data. `applyOverlay`
-- indicizza per ruolo (`added[state]`), quindi su una riga `core` cercava una lista che non
-- esiste e cadeva con «Cannot read properties of undefined (reading 'push')» — sia
-- rielaborando un documento di quel tipo, sia esportando la mappa corretta, che è l'unico
-- modo in cui quelle decisioni diventano file.
--
-- `core` e `conditional` diventano `optional` perché è quello che facevano: solo
-- `required` mandava un documento in revisione per un campo senza valore (il vecchio
-- `fact-reader`, `missingRequired`), gli altri tre no. Un campo che non bloccava prima non
-- comincia a bloccare adesso, e la decisione del revisore — «questo campo qui serve» —
-- resta scritta.
--
-- La cronologia non si tocca: `profile_actions` racconta quello che è stato fatto, col
-- ruolo che aveva quel nome allora, e riscriverla sarebbe riscrivere il racconto. I suoi
-- valori si traducono in lettura (`toMapValue` nel DAO), dove servono ad annullare.

UPDATE profile_overrides SET state = 'optional' WHERE state IN ('core', 'conditional');

-- E il CHECK torna a dire la verità: gli stati sono tre. SQLite non li cambia in
-- place, quindi tabella nuova, copia, rinomina.
CREATE TABLE profile_overrides_v2 (
  document_type TEXT NOT NULL,
  field_id      TEXT NOT NULL,
  -- «excluded» = non utile per questo tipo. È uno stato, non una cancellazione: resta
  -- scritto che quel campo è stato scartato di proposito, e l'export lo riporta.
  state         TEXT NOT NULL CHECK (state IN ('required', 'optional', 'excluded')),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (document_type, field_id)
) WITHOUT ROWID;

INSERT INTO profile_overrides_v2 (document_type, field_id, state, updated_at)
  SELECT document_type, field_id, state, updated_at FROM profile_overrides;

DROP TABLE profile_overrides;
ALTER TABLE profile_overrides_v2 RENAME TO profile_overrides;
