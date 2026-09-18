-- Come il motore è arrivato a proporre quel valore, accanto a quale regola l'ha trovato.
--
-- La 0012 ha legato l'evidenza alla regola appresa (`rule_id`), che risponde a «chi». Alla
-- misura pre/post della fase 2 serve anche «come»: se un numero deludente viene dalle
-- letture sulla riga dell'etichetta o da quelle sulla riga successiva, e se le regole che
-- hanno funzionato erano di modulo o di tipo. Senza queste due colonne il confronto dà un
-- totale e nient'altro, e non si sa quale parte smontare.
--
-- Si paga adesso perché è retroattivo al contrario: le evidenze scritte da qui in avanti
-- portano la provenienza, quelle già a database restano a NULL e non si possono ricostruire.
-- Il corpus si sta riempiendo ora.
--
-- `extraction_strategy` vale `LABEL_STRICT` (valore letto dopo l'etichetta, stessa riga) o
-- `NEXT_LINE` (riga sotto, quando la riga dell'etichetta finisce lì). Nessun CHECK: quando
-- l'estrazione imparerà altri modi di leggere, la colonna li accoglie senza ricostruire la
-- tabella, e chi legge il dato sa che il vocabolario cresce.
--
-- `rule_scope` è `TEMPLATE` o `CLASS`, e resta NULL quando l'etichetta viene dal registry:
-- lì non c'è nessuna regola appresa di cui riportare l'ambito.
--
-- Manca di proposito il punteggio del candidato: oggi l'ordine fra due letture lo decide un
-- confronto a cascata (livello dell'etichetta, lunghezza, stessa riga, validatori, ordine
-- nel documento), non un numero. Una colonna riempita con la confidence sarebbe il doppione
-- di una colonna che c'è già. La aprirà la migrazione della PR che accende il ranking, che
-- è anche l'unica che avrà qualcosa da scriverci.

ALTER TABLE evidence ADD COLUMN extraction_strategy TEXT;
ALTER TABLE evidence ADD COLUMN rule_scope TEXT;
