-- Un valore che il motore ha dedotto, non letto sul documento.
--
-- Fino a qui ogni valore proposto veniva da una riga del documento, e l'evidenza lo
-- dimostrava: `evidence_id` pieno voleva dire «letto», vuoto voleva dire «non trovato».
-- La scadenza di un attestato di formazione rompe la coppia: un attestato quasi mai la
-- scrive, e il revisore la calcola dalla normativa (cinque anni dal rilascio per la
-- formazione dei lavoratori). Il motore ora la propone, e senza questa colonna sarebbe
-- indistinguibile da una data letta: nel dataset conterebbe come una lettura riuscita,
-- e la misura dell'estrazione si gonfierebbe di valori che nessuno ha mai letto.
--
-- `computed = 1` dice soltanto che la **proposta** è dedotta. Se il revisore la corregge
-- vince la correzione, come sempre, e nel dataset il campo torna `origin: "REVIEWER"`.
--
-- Le righe scritte prima restano a 0: nessuna di loro poteva essere dedotta, perché il
-- motore non sapeva farlo.

ALTER TABLE fields ADD COLUMN computed INTEGER NOT NULL DEFAULT 0;
