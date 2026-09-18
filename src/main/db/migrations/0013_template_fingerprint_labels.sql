-- L'impronta del modulo cambia algoritmo: da `pdfjs-first-page-lines` a
-- `pdfjs-first-page-labels`.
--
-- La vecchia impronta era lo sha-256 di tutte le righe della prima pagina con le lettere
-- ridotte a `A` e le cifre a `9`. Mascherare i caratteri non bastava: quante parole ha la
-- riga e quanti gruppi di cifre è ancora il dato, e l'hash copriva la pagina intera. Sul
-- campo ogni impronta corrispondeva a un solo documento, quindi nessuna regola di scope
-- TEMPLATE poteva arrivare a `minTemplateSupport: 2`.
--
-- Le impronte scritte dalle due versioni non sono confrontabili: queste righe tolgono di
-- mezzo le vecchie, invece di lasciarle a convivere con le nuove sotto lo stesso nome.

-- Si ricalcola: l'elaborazione la rifà, e l'export XLSX la ricava dalla copia in cache per
-- i documenti che non ripassano dalla pipeline.
UPDATE documents SET template_fingerprint = NULL;

-- Gli eventi restano — sono quello che il revisore ha deciso, e non cambia — ma senza
-- l'impronta vecchia, che raggrupperebbe per un criterio che non esiste più. Quello che
-- portano su tipo, campo ed etichetta continua ad alimentare le regole di scope CLASS.
UPDATE learning_events SET template_fingerprint = NULL;

-- Le regole di scope TEMPLATE sono appese a impronte che nessun documento avrà più: non
-- potrebbero mai più né confermarsi né smentirsi. Una regola non si cancella, chiude
-- REJECTED, e l'azione dice perché.
INSERT INTO learning_actions (id, at, kind, rule_id, before_state, after_state, detail)
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
      || substr(lower(hex(randomblob(2))), 2) || '-a'
      || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'RULE_REJECTED',
    id,
    status,
    'REJECTED',
    'Impronta del modulo ricalcolata con un altro algoritmo: la regola era legata a '
      || 'un''impronta che nessun documento avrà più.'
  FROM learning_rules
  WHERE scope = 'TEMPLATE' AND status <> 'REJECTED';

UPDATE learning_rules
  SET status = 'REJECTED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE scope = 'TEMPLATE' AND status <> 'REJECTED';
