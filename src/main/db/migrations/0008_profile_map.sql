-- La mappa «tipo documento ↔ dati da estrarre» corretta dal revisore, tenuta qui.
--
-- Fino alla 0007 una correzione riscriveva i JSON del registry e ne faceva un commit
-- git: il lavoro del revisore finiva in un repo che l'app impacchettata non ha, e su
-- una cartella di sola lettura non finiva da nessuna parte. Da qui in avanti i JSON del
-- registry sono la base immutabile, le correzioni stanno nel database accanto alle
-- annotazioni che le motivano, e i file corretti si producono su richiesta con l'export.
--
-- Tre tabelle: lo stato corrente della mappa, le etichette insegnate al motore, e la
-- cronologia di tutto quello che è stato fatto.

-- Lo stato corrente: una riga per ogni campo su cui il revisore ha deciso qualcosa.
-- Il campo assente da qui segue il profilo del registry, ed è il caso dei più.
CREATE TABLE profile_overrides (
  document_type TEXT NOT NULL,
  field_id      TEXT NOT NULL,
  -- «excluded» = non utile per questo tipo. È uno stato, non una cancellazione: resta
  -- scritto che quel campo è stato scartato di proposito, e l'export lo riporta.
  state         TEXT NOT NULL CHECK (
                  state IN ('required', 'core', 'optional', 'conditional', 'excluded')
                ),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (document_type, field_id)
) WITHOUT ROWID;

-- Le etichette con cui un campo compare nei documenti veri, insegnate al motore.
-- Nel registry gli hint sono per campo e non per tipo: qui si tiene anche da quale tipo
-- l'etichetta è stata insegnata, che serve solo alla cronologia.
CREATE TABLE profile_hint_labels (
  field_id      TEXT NOT NULL,
  label         TEXT NOT NULL,
  document_type TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (field_id, label)
) WITHOUT ROWID;

-- La cronologia: ogni azione sulla mappa, in ordine di tempo, con i numeri che l'hanno
-- motivata. Non si aggiorna e non si cancella — annullare una correzione è un'altra
-- riga, che dice cosa annulla.
CREATE TABLE profile_actions (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  -- ADD_FIELD | REMOVE_FIELD | SET_ROLE | ADD_HINT_LABEL | REVERT | RERUN | EXPORT
  kind          TEXT NOT NULL,
  document_type TEXT,
  field_id      TEXT,
  label         TEXT,
  /** Lo stato del campo prima e dopo: NULL se il campo non era (o non è) nella mappa. */
  before_state  TEXT,
  after_state   TEXT,
  /**
   * La riga che c'era su profile_overrides prima di questa azione: NULL quando il campo
   * seguiva il registry. Annullare l'azione rimette esattamente questo, che non sempre
   * coincide con before_state — un campo può essere «principale» perché lo dice il
   * registry, e allora annullare non deve lasciare una decisione che nessuno ha preso.
   */
  previous_override TEXT,
  detail        TEXT NOT NULL,
  /** I numeri delle annotazioni al momento dell'azione, come JSON. */
  numbers_json  TEXT,
  /** L'azione annullata da questa, quando kind = REVERT. */
  reverts_id    TEXT REFERENCES profile_actions (id),
  /** Quando questa azione è stata annullata; NULL finché vale. */
  reverted_at   TEXT
);

CREATE INDEX profile_actions_at ON profile_actions (at DESC);
CREATE INDEX profile_actions_type ON profile_actions (document_type, at DESC);

-- La cronologia unica mette insieme queste azioni e gli eventi dei documenti: leggere
-- gli eventi in ordine di tempo su tutta la tabella era l'unica query che mancava.
CREATE INDEX events_at ON events (at DESC);
