-- La nota che il revisore scrive chiudendo il documento (Salva o Scarta).
--
-- Finora restava solo dentro il testo della riga di timeline («Nota: ...»), da cui non si
-- rilegge: per riportarla nell'export serve una colonna sua. NULL = nessuna nota, che è
-- il caso normale — la nota è facoltativa e serve a spiegare i casi strani, che sono
-- proprio quelli che chi lavora il dataset in foglio vuole ritrovare.
ALTER TABLE documents ADD COLUMN review_note TEXT;
