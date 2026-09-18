# Code Review 17/09/2026

Review completata su src/main (10 angoli di analisi + verifica; suite 613 test, typecheck e lint tutti verdi — quindi tutto quanto segue è semantico, non meccanico).

### Estrazione — dati sbagliati che sembrano giusti

1. extract/heuristics.ts:144 — findMoney legge le date come importi. Verificato in Node: findMoney("Totale al 31.12.2025 di 1.234,56") → 31.12. L'alternativa \d+\.\d{1,2} aggancia 31.12, e hasDecimals soddisfa la guardia "un numero nudo non è un totale", quindi il loop non arriva mai all'importo vero. Colpisce total_amount / taxable_amount / premium_amount su entrambi i motori. ✅
2. extract/heuristics.ts:416 — document_number viene riempito col protocollo. extractValue instrada entrambi a findNumber(), che prova sempre prima il pattern protocollo sull'intera riga e scarta la keyword che aveva matchato. "Fattura n. 114 - Prot. n. 2026/554321" → 2026/554321. L'evidence salvata è la riga intera, quindi il revisore vede una citazione plausibile accanto al valore sbagliato. ✅
3. extract/v2/fact-reader.ts:592 — campo di profilo assente dall'ontologia sparisce. Il continue salta specs.set(), quindi il campo non finisce né in facts né in missingRequired: il run chiude COMPLETED con coverage 1.0 su un required mai cercato. Unica traccia: una stringa UNKNOWN_FIELD: nei conflicts. ✅
4. extract/text.ts:46 — OCR fallito viene restituito come NATIVE_TEXT. Build senza tessdata o worker che non parte ⇒ ogni PDF scansionato produce 0 campi con run COMPLETED, mai ritentato (needsV2Extraction vede un run valido). Gli zeri finiscono nel dataset esportato e nelle metriche di profilo. ✅
5. pipeline.ts:380 — penalità OCR applicata a livello documento. Un solo allegato scansionato in fondo a un PDF di 10 pagine declassa tutti i campi letti dal testo nativo (0.85 → 0.75), che scendono sotto AUTO_ACCEPT_THRESHOLD e passano a NEEDS_REVIEW. pagesOf ha già il source per pagina e lo butta via. ✅

### Perdita di lavoro del revisore

6. drive/fetch.ts:52 — received_at scritto prima del download. Se drive.download fallisce, al retry isStale è false e il file resta marcato aggiornato: il revisore annota ed esporta la versione vecchia senza alcun segnale. Solo force recupera. Il test a tests/drive-fetch.test.ts:265 copre solo il primo download.
7. profile-refinement.ts:94 — l'invariante "una estrazione alla volta" copre solo enqueue(). processDocument è chiamato direttamente da altri 4 punti (index.ts:122, reprocess.ts:51, profile-refinement.ts:169, handler drive:fetch). fields.replaceForDocument rigenera gli UUID: se il loop di startup raggiunge il documento aperto, il salvataggio del revisore muore con Campo non trovato su questo documento. Serializzare per documentId dentro createDocumentProcessor darebbe l'invariante a tutti.
8. profile-map.ts:209 — revertProfileAction non controlla isMapEdit. Un id di azione REVERT passa tutte le guardie, e setOverride(..., 'many' as FieldState) scrive una cardinalità nella colonna state. L'overlay corrotto viene cachato in memoria e servito al motore per ogni documento successivo.
9. profile-map.ts:268 — exportProfileBundle salta la traduzione registry-alignment. shared/profile-bundle.ts non importa @shared/registry-alignment (gli altri due export sì). Le correzioni sulle tre classi aliasate — contratto_raggruppamento_temporaneo_imprese, hse_risk, payroll_contributions — vengono scartate senza errore all'import in pratica-ai.

### Robustezza / crash

10. extract/v2/profile-loader.ts:234 — accesso bracket non guardato sulla mappa profili. documentTypeSlugSchema accetta constructor, e JSON.parse('{}')['constructor'] è truthy ⇒ profileSource dice V2_EXPLICIT, la pipeline non prende la via SKIPPED_NO_PROFILE, e fact-reader.ts:574 esplode su ...profile.required_fields. Documento non più processabile. registry/index.ts:94 guarda già lo stesso pattern con Object.hasOwn.
11. auth/service.ts:211 — qualsiasi errore di getAccessToken() cancella il refresh token. DNS, captive portal, 5xx di Google: il token valido viene rmSync'd e serve rifare il consenso browser. Va ristretto a invalid_grant / 400-401.
12. index.ts:33 — lock single-instance senza return. app.quit() è asincrono, l'esecuzione prosegue fino a app.whenReady().then(start): due migrate() concorrenti sullo stesso file WAL — esattamente ciò che il commento alla riga 32 dice di evitare.
13. index.ts:78 — mainWindow non viene mai riazzerato (nessun handler closed in tutto src/main). Su macOS, dopo la chiusura della finestra, mainWindow?.webContents lancia Object has been destroyed prima della guardia a ipc/index.ts:203, e il second-instance handler muore su isMinimized() lasciando l'app apparentemente appesa.
14. extract/ocr-engine.ts:164 — tesseract ??= await startTesseract() è una race. Due richieste OCR concorrenti (reprocess in background + selezione a mano) avviano due worker; il primo viene sovrascritto e mai terminato, e le due recognize() finiscono su un worker documentato come single-job.
15. db/dao/learning.ts:146 — JSON.parse non protetto in toRule. Ogni altra colonna JSON del layer è difensiva; questa no, ed è sulla hot path (activeRules() da pipeline.ts:109). Una riga pattern_json troncata fa fallire l'estrazione di ogni documento. Stessa forma a learning.ts:168.

### Sotto la soglia, ma verificati

drive/client.ts:264 nome .part fisso (download concorrenti si cancellano a vicenda) · auth/service.ts:183 nessun dedup in-flight ⇒ due refresh con lo stesso rotating token · ocr.ts:53,106 le richieste pendenti non vengono mai risolte su exit/dispose (hang di 120 s) · window.ts:32 shell.openExternal su URL non validato, senza guardia will-navigate né validazione sender/frame in handle() · heuristics.ts:84 pivot anno a 2 cifre: 69 → 2069 contro la regola POSIX citata nel commento · validators.ts:36 validator sconosciuto passa silenziosamente, non_negative_money accetta NaN · performance: fact-reader.ts:475 rifà il fold dell'intero documento per ogni campo (~22×/estrazione), classify-v2.ts:65 copia 60 KB per alias su ~2.800 alias, e mancano gli indici FK su field_items.evidence_id e sulle due colonne corrected_evidence_id (re-estrazione misurata 685× più lenta) · repository.ts:201 recomputeConfidence duplica averageConfidence su una popolazione diversa · containsPhraseV2 è testata ma la produzione usa un quasi-duplicato privato.

Due piste plausibili smentite: pruneReviewer copre già i pick manuali (finiscono in corrected_evidence_id), e l'ORDER BY mancante su allItems è innocuo perché itemsToSingle ordina per item_index.
