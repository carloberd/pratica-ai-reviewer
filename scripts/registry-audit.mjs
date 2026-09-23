/**
 * Controlla il registry: i campi e la mappa «tipo documento → campi».
 *
 *   node scripts/registry-audit.mjs
 *   node scripts/registry-audit.mjs resources/registry
 *   node scripts/registry-audit.mjs --json
 *
 * Serve a due cose diverse, e per questo i controlli sono divisi in due gruppi.
 *
 * Gli **invarianti** sono le cose che oggi valgono e che non devono smettere di valere:
 * ogni campo chiesto da un tipo esiste, i due ruoli non si sovrappongono, un'eccezione per
 * tipo vale su un campo che quel tipo chiede, i validatori dipendono dalla forma del campo
 * e non dal campo, nessuna descrizione ripete la sua etichetta. Oggi sono tutti a zero
 * violazioni; se uno si rompe è una regressione, e lo script esce con 1.
 *
 * L'**avanzamento** sono i buchi noti: i campi `object` senza schema di riga, i campi senza
 * alias, gli attributi obbligatori che nessuno calcola. Sono numeri che devono scendere,
 * non condizioni da superare: non fanno mai fallire il comando, così questo script si può
 * tenere nel gate anche prima che siano a zero.
 *
 * Le chiavi con cui i due file chiudono quei buchi, e che questo script legge:
 *
 *   `columns`        le colonne della riga di un campo `object`, in ordine: senza di esse
 *                    la riga non ha uno schema e il tipo che la chiede non è convertibile.
 *   `enum`           i valori ammessi di un campo chiuso, come `money.currency`.
 *   `scale`          la convenzione di scala di una percentuale: `0_100` è «3,5 = 3,5%».
 *   `derived`        il campo non sta scritto sulla carta, lo calcola il motore: allora non
 *                    ha una frase da quotare e `evidence_required` è `false`.
 *   `derived_fields` i campi derivati che un tipo vuole, accanto a `required_fields` e
 *                    `optional_fields`: un documento non va in revisione perché mancano.
 *
 * Il registry si scrive altrove e qui non si tocca niente: entrano due file, esce un
 * rapporto.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_DIR = 'resources/registry'

const FIELDS_FILE = 'fields.json'
const DOCUMENT_FIELDS_FILE = 'document_fields.json'

/** I ruoli con cui un tipo elenca i campi che vuole leggere sul documento. */
const ROLE_KEYS = ['required_fields', 'optional_fields']

/**
 * I campi che un tipo vuole ma che nessuno legge sul documento: li calcola il motore. Non
 * sono un terzo ruolo del lettore — stanno fuori dai due — ma il tipo li elenca lo stesso,
 * perché fanno parte di quello che di quel documento si sa.
 */
const DERIVED_KEY = 'derived_fields'

/** Tutte le liste di campi che un tipo può scrivere: i due ruoli più i derivati. */
const FIELD_LIST_KEYS = [...ROLE_KEYS, DERIVED_KEY]

/** Le eccezioni che un tipo può mettere al posto di quello che dice l'ontologia. */
const OVERRIDE_KEYS = [
  'field_validator_overrides',
  'field_pii_overrides',
  'field_description_overrides'
]

/**
 * Il validatore che ogni coppia (tipo, format) deve avere. È la tabella che tiene insieme
 * la forma di un campo e i controlli che gli girano sopra: se qualcuno aggiunge un campo
 * `date` senza `valid_date`, o mette `non_negative_money` su un saldo che può essere in
 * rosso, è qui che si vede. Una coppia che non compare non ha validatori.
 */
const VALIDATORS_OF = {
  'date|date': ['valid_date'],
  'money|decimal': ['non_negative_money'],
  'money|signed_decimal': [],
  'identifier|iban': ['iban_checksum'],
  'identifier|tax_id': ['tax_id_format'],
  'identifier|vat_number': ['vat_number_format'],
  'identifier|italian_tax_code': ['italian_tax_code_format'],
  'identifier|vehicle_plate': ['vehicle_plate'],
  'identifier|vin': ['vin'],
  'identifier|cig': ['cig_format'],
  'identifier|cup': ['cup_format']
}

/** I validatori che `src/main/extract/v2/validators.ts` sa eseguire. */
const RUNNABLE = new Set([
  'non_empty',
  'valid_date',
  'non_negative_money',
  'iban_checksum',
  'tax_id_format',
  'vat_number_format',
  'italian_tax_code_format',
  'vehicle_plate',
  'vin',
  'cig_format',
  'cup_format'
])

/**
 * Come ogni tipo dell'ontologia diventa una foglia del template NuExtract. `object` non
 * c'è apposta: senza le colonne della riga non esiste una conversione, ed è il buco che il
 * rapporto conta per primo.
 */
const NUEXTRACT_TYPE_OF = {
  string: 'verbatim-string | string',
  identifier: 'verbatim-string',
  date: 'date-time',
  money: 'number',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean'
}

/** I format che il lettore di identificativi riconosce: gli altri leggono per token. */
const READER_FORMATS = new Set([
  'tax_id',
  'italian_tax_code',
  'vat_number',
  'rea_number',
  'iban',
  'account_number',
  'vehicle_plate',
  'vin',
  'cig',
  'cup'
])

/**
 * I tipi che una colonna di un campo `object` può avere: lo stesso vocabolario dei campi,
 * meno `object`. Una riga di riga non esiste: quello che una colonna non sa dire va scritto
 * come un campo a parte, non annidato.
 */
const COLUMN_TYPES = new Set(Object.keys(NUEXTRACT_TYPE_OF))

/** Le convenzioni di scala che una percentuale può dichiarare. */
const PERCENT_SCALES = new Set(['0_100'])

/**
 * Gli attributi che il Brain MVP ha introdotto per non moltiplicare le classi. Non stanno
 * scritti sul documento: la direzione si ricava confrontando le parti con l'azienda, il
 * ruolo della controparte da quella, il tipo di corso dal corso. Finché non li calcola
 * qualcuno, un tipo che li chiede obbligatori manda in revisione ogni suo documento.
 */
const ATTRIBUTE_FIELDS = [
  'document.direction',
  'document.variant',
  'document.lifecycle_stage',
  'counterparty.role',
  'event_type',
  'course_type',
  'risk_type',
  'standard',
  'policy_type',
  'utility_type',
  'receipt_type',
  'absence_type'
]

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dir = args.find((a) => !a.startsWith('-')) ?? DEFAULT_DIR

const read = (name) => {
  const path = join(dir, name)
  if (!existsSync(path)) {
    console.error(`manca ${path}`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

const catalog = read(FIELDS_FILE)
const map = read(DOCUMENT_FIELDS_FILE)
const fields = catalog.fields
const documentTypes = map.document_types

const fieldIds = Object.keys(fields)
const typeIds = Object.keys(documentTypes)

const shapeOf = (id) => `${fields[id].type}/${fields[id].format ?? '—'}`
const expectedValidators = (id) => VALIDATORS_OF[`${fields[id].type}|${fields[id].format ?? '—'}`]

/** I campi che un tipo chiede di leggere sul documento, senza distinguere il ruolo. */
const fieldsOf = (type) => new Set(ROLE_KEYS.flatMap((key) => documentTypes[type]?.[key] ?? []))

/** I campi che un tipo vuole e che nessuno legge: li calcola il motore. */
const derivedOf = (type) => new Set(documentTypes[type]?.[DERIVED_KEY] ?? [])

/** Quante volte ogni campo è chiesto da un tipo, derivati compresi: è la sua casa. */
const usage = new Map()
for (const type of typeIds) {
  for (const field of new Set([...fieldsOf(type), ...derivedOf(type)])) {
    usage.set(field, (usage.get(field) ?? 0) + 1)
  }
}

/** Le colonne dichiarate da un campo, in ordine. */
const columnsOf = (id) => fields[id].columns ?? []

/** Un campo `object` senza colonne non ha uno schema di riga, e non si converte. */
const hasRowSchema = (id) => fields[id].type !== 'object' || columnsOf(id).length > 0

const invariants = []
const progress = []

/** Un controllo che deve restare a zero: se cresce, qualcuno ha rotto qualcosa. */
const invariant = (title, offenders, describe) => {
  invariants.push({ title, count: offenders.length, sample: offenders.slice(0, 8).map(describe) })
}

/** Un buco noto: un numero da guardare scendere, che non fa fallire niente. */
const gap = (title, count, note, sample = []) => {
  progress.push({ title, count, note, sample: sample.slice(0, 8) })
}

// ─── Invarianti ──────────────────────────────────────────────────────────────

const orphans = []
for (const type of typeIds) {
  for (const key of FIELD_LIST_KEYS) {
    for (const field of documentTypes[type][key] ?? []) {
      if (!fields[field]) orphans.push({ type, field, key })
    }
  }
}
invariant(
  'campi chiesti da un tipo ma assenti dall’ontologia',
  orphans,
  (o) => `${o.field} (in ${o.type}.${o.key})`
)

const bothRoles = []
for (const type of typeIds) {
  const required = new Set(documentTypes[type].required_fields ?? [])
  for (const field of documentTypes[type].optional_fields ?? []) {
    if (required.has(field)) bothRoles.push({ type, field })
  }
}
invariant(
  'campi che un tipo chiede obbligatori e opzionali insieme',
  bothRoles,
  (o) => `${o.type}: ${o.field}`
)

const duplicates = []
for (const type of typeIds) {
  for (const key of FIELD_LIST_KEYS) {
    const list = documentTypes[type][key] ?? []
    if (new Set(list).size !== list.length) duplicates.push({ type, key })
  }
}
invariant('liste di campi con lo stesso campo ripetuto', duplicates, (o) => `${o.type}.${o.key}`)

const strayOverrides = []
for (const type of typeIds) {
  const declared = fieldsOf(type)
  for (const key of OVERRIDE_KEYS) {
    for (const field of Object.keys(documentTypes[type][key] ?? {})) {
      // Un'eccezione su un campo che il tipo non chiede non cambierebbe niente, e dice che
      // la mappa o l'eccezione sono sbagliate. Il caricatore la rifiuta all'avvio.
      if (!fields[field] || !declared.has(field)) strayOverrides.push({ type, field, key })
    }
  }
}
invariant(
  'eccezioni per tipo su un campo che quel tipo non chiede',
  strayOverrides,
  (o) => `${o.type}.${o.key}: ${o.field}`
)

const idMismatch = fieldIds.filter((id) => fields[id].id !== id)
invariant('campi la cui chiave non è il loro id', idMismatch, (id) => `${id} → ${fields[id].id}`)

const wrongValidators = []
for (const id of fieldIds) {
  const want = expectedValidators(id) ?? []
  const have = fields[id].validators ?? []
  if (want.join('+') !== [...have].sort().join('+')) wrongValidators.push({ id, want, have })
}
invariant(
  'validatori diversi da quelli della forma del campo',
  wrongValidators,
  (o) =>
    `${o.id} (${shapeOf(o.id)}): «${o.have.join('+') || '—'}», atteso «${o.want.join('+') || '—'}»`
)

const unrunnable = []
for (const id of fieldIds) {
  for (const validator of fields[id].validators ?? []) {
    if (!RUNNABLE.has(validator)) unrunnable.push({ id, validator })
  }
}
for (const type of typeIds) {
  for (const [field, list] of Object.entries(documentTypes[type].field_validator_overrides ?? {})) {
    for (const validator of list) {
      if (!RUNNABLE.has(validator)) unrunnable.push({ id: `${type}: ${field}`, validator })
    }
  }
}
invariant(
  'validatori che il motore non sa eseguire',
  unrunnable,
  (o) => `${o.id} → «${o.validator}»`
)

const mutedDescriptions = fieldIds.filter(
  (id) => !fields[id].description || fields[id].description === fields[id].label_it
)
invariant(
  'descrizioni vuote o che ripetono l’etichetta',
  mutedDescriptions,
  (id) => `${id} — «${fields[id].description}»`
)

const aliasEchoes = []
for (const id of fieldIds) {
  const seen = new Set([fields[id].label_it.toLowerCase()])
  for (const alias of fields[id].label_aliases_it ?? []) {
    const key = alias.toLowerCase()
    if (seen.has(key)) aliasEchoes.push({ id, alias })
    seen.add(key)
  }
}
invariant(
  'alias che ripetono l’etichetta o un altro alias',
  aliasEchoes,
  (o) => `${o.id} — «${o.alias}»`
)

const cardinalityMismatch = fieldIds.filter(
  (id) => fields[id].type === 'object' && fields[id].default_cardinality !== 'many'
)
invariant(
  'campi «object» che chiedono un valore solo',
  cardinalityMismatch,
  (id) => `${id} — ${fields[id].default_cardinality}`
)

const emptyTypes = typeIds.filter((type) => fieldsOf(type).size === 0)
invariant('tipi di documento senza nessun campo', emptyTypes, (t) => t)

const noRequired = typeIds.filter(
  (type) => (documentTypes[type].required_fields ?? []).length === 0
)
invariant('tipi senza nemmeno un campo obbligatorio', noRequired, (t) => t)

const columnKeyClashes = []
const columnTypeStrays = []
const mutedColumns = []
const columnsOnScalars = []
for (const id of fieldIds) {
  const columns = columnsOf(id)
  if (columns.length > 0 && fields[id].type !== 'object') columnsOnScalars.push(id)
  const seen = new Set()
  for (const column of columns) {
    if (seen.has(column.id)) columnKeyClashes.push({ id, column: column.id })
    seen.add(column.id)
    if (!COLUMN_TYPES.has(column.type)) columnTypeStrays.push({ id, column })
    if (!column.label_it) mutedColumns.push({ id, column: column.id })
  }
}
invariant(
  'colonne con lo stesso id dentro lo stesso campo',
  columnKeyClashes,
  (o) => `${o.id}: «${o.column}»`
)
invariant(
  'colonne con un tipo fuori dal vocabolario dell’ontologia',
  columnTypeStrays,
  (o) => `${o.id}.${o.column.id} — «${o.column.type}»`
)
invariant('colonne senza etichetta', mutedColumns, (o) => `${o.id}.${o.column}`)
invariant(
  'colonne su un campo che non è «object»',
  columnsOnScalars,
  (id) => `${id} (${shapeOf(id)})`
)

const brokenEnums = []
for (const id of fieldIds) {
  const values = fields[id].enum
  if (!values) continue
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') brokenEnums.push({ id, value })
    else if (seen.has(value)) brokenEnums.push({ id, value })
    seen.add(value)
  }
}
invariant('valori di enum vuoti o ripetuti', brokenEnums, (o) => `${o.id} — «${o.value}»`)

// Un campo che il motore calcola non ha una frase da quotare: chiedergliene una lo
// manderebbe in revisione per un'evidenza che il documento non porta.
const derivedWantingEvidence = fieldIds.filter(
  (id) => fields[id].derived === true && fields[id].evidence_required !== false
)
invariant(
  'campi derivati che chiedono comunque una citazione',
  derivedWantingEvidence,
  (id) => `${id} — evidence_required: ${fields[id].evidence_required}`
)

const derivedAndRead = []
for (const type of typeIds) {
  const read = fieldsOf(type)
  for (const field of derivedOf(type)) {
    if (read.has(field)) derivedAndRead.push({ type, field })
  }
}
invariant(
  'campi che un tipo elenca fra i derivati e insieme fra quelli da leggere',
  derivedAndRead,
  (o) => `${o.type}: ${o.field}`
)

const undeclaredDerived = []
for (const type of typeIds) {
  for (const field of derivedOf(type)) {
    if (fields[field] && fields[field].derived !== true) undeclaredDerived.push({ type, field })
  }
}
invariant(
  'campi derivati da un tipo ma non dichiarati «derived» dall’ontologia',
  undeclaredDerived,
  (o) => `${o.type}: ${o.field}`
)

const badScales = fieldIds.filter(
  (id) => fields[id].scale !== undefined && !PERCENT_SCALES.has(fields[id].scale)
)
invariant(
  'convenzioni di scala che nessuno sa leggere',
  badScales,
  (id) => `${id} — «${fields[id].scale}»`
)

// ─── Avanzamento ─────────────────────────────────────────────────────────────

const objectFields = fieldIds.filter((id) => fields[id].type === 'object')
const schemalessObjects = objectFields.filter((id) => !hasRowSchema(id))
const blockedTypes = typeIds.filter((type) =>
  [...fieldsOf(type)].some((f) => fields[f] && !hasRowSchema(f))
)
gap(
  'campi «object» senza schema di riga',
  schemalessObjects.length,
  `bloccano ${blockedTypes.length} tipi su ${typeIds.length}: senza le colonne non esiste una conversione`,
  schemalessObjects
    .map((id) => `${id} (in ${usage.get(id) ?? 0} tipi)`)
    .sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0))
)

const noAliases = fieldIds.filter((id) => (fields[id].label_aliases_it ?? []).length === 0)
gap(
  'campi senza nessun alias di etichetta',
  noAliases.length,
  'il motore cerca solo la loro etichetta: un documento che la scrive diversamente lascia il campo vuoto',
  noAliases
    .map((id) => ({ id, uses: usage.get(id) ?? 0 }))
    .sort((a, b) => b.uses - a.uses)
    .map((entry) => `${entry.id} — «${fields[entry.id].label_it}» (in ${entry.uses} tipi)`)
)

// Un attributo che il tipo elenca fra i derivati è già a posto: nessuno lo cerca sulla
// carta, e la sua assenza non manda in revisione. Contano solo quelli rimasti obbligatori.
const attributesRequired = []
for (const type of typeIds) {
  const derived = derivedOf(type)
  for (const field of documentTypes[type].required_fields ?? []) {
    if (ATTRIBUTE_FIELDS.includes(field) && !derived.has(field)) {
      attributesRequired.push(`${type}: ${field}`)
    }
  }
}
gap(
  'attributi obbligatori che nessuno calcola',
  attributesRequired.length,
  'non stanno scritti sul documento: finché non li deriva qualcuno, il campo resta vuoto e ogni documento di quel tipo va in revisione',
  attributesRequired
)

const unknownFormats = fieldIds.filter(
  (id) =>
    fields[id].type === 'identifier' && fields[id].format && !READER_FORMATS.has(fields[id].format)
)
gap(
  'identificativi con un format che il lettore non conosce',
  unknownFormats.length,
  'si leggono per token come se non avessero format: il format c’è scritto ma non cambia niente',
  unknownFormats.map((id) => `${id} — «${fields[id].format}»`)
)

const percentages = fieldIds.filter(
  (id) => fields[id].format === 'percentage' && fields[id].scale === undefined
)
gap(
  'percentuali senza convenzione di scala',
  percentages.length,
  '22 o 0,22? finché non sta scritto, metà dei documenti va in un modo e metà nell’altro',
  percentages
)

const openEnums = fieldIds.filter(
  (id) => fields[id].format === 'currency' && (fields[id].enum ?? []).length === 0
)
gap(
  'campi da enum lasciati stringa libera',
  openEnums.length,
  'una valuta senza enum arriva scritta in tutti i modi in cui il documento la scrive',
  openEnums
)

const labels = new Map()
for (const id of fieldIds) {
  const label = fields[id].label_it
  labels.set(label, [...(labels.get(label) ?? []), id])
}
const sharedLabels = [...labels.entries()].filter(([, ids]) => ids.length > 1)
gap(
  'etichette condivise da più campi',
  sharedLabels.length,
  'come chiavi di template sono ambigue: le distingue solo la descrizione',
  sharedLabels.map(([label, ids]) => `«${label}» → ${ids.join(', ')}`)
)

const unused = fieldIds.filter((id) => !usage.has(id))
gap(
  'campi dell’ontologia mai chiesti da un tipo',
  unused.length,
  'o servono a tipi che non ci sono ancora, o vanno via: sono ontologia non verificata',
  unused
)

const flagValues = new Set(fieldIds.map((id) => fields[id].evidence_required))
const constantFlag = flagValues.size <= 1
gap(
  'campi con «evidence_required» sempre uguale',
  constantFlag ? fieldIds.length : 0,
  constantFlag
    ? `vale ${[...flagValues][0]} su tutti: il campo non distingue niente`
    : `${fieldIds.filter((id) => fields[id].evidence_required === false).length} campi ` +
        'non chiedono una citazione: sono quelli che il motore calcola',
  []
)

// ─── Il peso della mappa ─────────────────────────────────────────────────────

const requiredPerType = typeIds.map((type) => (documentTypes[type].required_fields ?? []).length)
const optionalPerType = typeIds.map((type) => (documentTypes[type].optional_fields ?? []).length)
const sum = (values) => values.reduce((total, value) => total + value, 0)
const average = (values) => (values.length === 0 ? 0 : sum(values) / values.length)

const heaviest = typeIds
  .map((type) => ({ type, required: (documentTypes[type].required_fields ?? []).length }))
  .sort((a, b) => b.required - a.required)
  .slice(0, 8)

const byOntologyType = {}
for (const id of fieldIds) {
  const t = fields[id].type
  byOntologyType[t] = (byOntologyType[t] ?? 0) + 1
}

/**
 * La foglia del template NuExtract di una colonna o di un campo scalare. Un campo con
 * `enum` non è una stringa libera: il template porta i valori ammessi, e il modello sceglie
 * fra quelli invece di ricopiare come il documento scrive la valuta.
 */
const leafOf = (spec) => {
  if ((spec.enum ?? []).length > 0) return `[${spec.enum.map((v) => `"${v}"`).join(' | ')}]`
  return NUEXTRACT_TYPE_OF[spec.type] ?? 'da definire'
}

/**
 * Il template di un campo. Un `object` con le colonne diventa l'oggetto della riga, che la
 * cardinalità `many` ripete: è la conversione che senza `columns` non si poteva scrivere.
 */
const templateOf = (id) => {
  const spec = fields[id]
  if (spec.type !== 'object') return leafOf(spec)
  const columns = columnsOf(id)
  if (columns.length === 0) return 'da definire'
  return `[{ ${columns.map((c) => `"${c.id}": ${leafOf(c)}`).join(', ')} }]`
}

const rowTemplates = objectFields
  .filter((id) => hasRowSchema(id))
  .map((id) => ({ id, uses: usage.get(id) ?? 0, template: templateOf(id) }))
  .sort((a, b) => b.uses - a.uses)

const readyTypes = typeIds.filter((type) => !blockedTypes.includes(type))
const states = {}
for (const type of typeIds) {
  const state = documentTypes[type].schema_state ?? '—'
  states[state] = (states[state] ?? 0) + 1
}

const report = {
  registry: dir,
  fieldsVersion: catalog.version,
  mapVersion: map.version,
  counts: {
    fields: fieldIds.length,
    types: typeIds.length,
    required: sum(requiredPerType),
    optional: sum(optionalPerType)
  },
  invariants,
  progress,
  weight: {
    requiredPerType: Math.round(average(requiredPerType) * 10) / 10,
    optionalPerType: Math.round(average(optionalPerType) * 10) / 10,
    heaviest
  },
  states,
  conversion: {
    readyTypes: readyTypes.length,
    blockedTypes: blockedTypes.length,
    rowsWithSchema: rowTemplates.length,
    rowsWithoutSchema: schemalessObjects.length,
    enums: fieldIds.filter((id) => (fields[id].enum ?? []).length > 0).length,
    byOntologyType: Object.fromEntries(
      Object.entries(byOntologyType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => [
          t,
          {
            fields: n,
            nuextract:
              t === 'object'
                ? `[{ … }] dalle «columns» (${rowTemplates.length} su ${n} le hanno)`
                : (NUEXTRACT_TYPE_OF[t] ?? 'da definire')
          }
        ])
    ),
    rows: rowTemplates.slice(0, 8)
  }
}

const broken = invariants.reduce((total, check) => total + check.count, 0)

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(broken > 0 ? 1 : 0)
}

const pad = (n) => String(n).padStart(5)
const rule = (char = '─') => console.log(char.repeat(78))

console.log(`\nregistry ${dir} — campi v${report.fieldsVersion}, mappa v${report.mapVersion}`)
console.log(
  `${report.counts.fields} campi, ${report.counts.types} tipi di documento, ` +
    `${report.counts.required} richieste obbligatorie e ${report.counts.optional} opzionali`
)

rule()
console.log('INVARIANTI — devono restare a zero\n')
for (const check of invariants) {
  const mark = check.count === 0 ? 'ok  ' : 'ROTTO'
  console.log(`  ${mark} ${pad(check.count)}  ${check.title}`)
  for (const line of check.sample) console.log(`               ⤷ ${line}`)
  if (check.count > check.sample.length) {
    console.log(`               ⤷ …e altri ${check.count - check.sample.length}`)
  }
}

rule()
console.log('AVANZAMENTO — numeri da far scendere\n')
for (const item of progress) {
  console.log(`  ${pad(item.count)}  ${item.title}`)
  console.log(`         ${item.note}`)
  for (const line of item.sample) console.log(`         ⤷ ${line}`)
  if (item.count > item.sample.length && item.sample.length > 0) {
    console.log(`         ⤷ …e altri ${item.count - item.sample.length}`)
  }
  console.log('')
}

rule()
console.log('QUANTO PESA LA MAPPA\n')
console.log(`  ${report.weight.requiredPerType} campi obbligatori per tipo, in media`)
console.log(`  ${report.weight.optionalPerType} opzionali per tipo, in media`)
console.log('  I tipi che ne chiedono di più:')
for (const entry of report.weight.heaviest) {
  console.log(`         ⤷ ${pad(entry.required)}  ${entry.type}`)
}
console.log('')
console.log('  Stato delle mappe:')
for (const [state, count] of Object.entries(report.states).sort((a, b) => b[1] - a[1])) {
  console.log(`         ⤷ ${pad(count)}  ${state}`)
}

rule()
console.log('CONVERSIONE A TEMPLATE NUEXTRACT\n')
for (const [type, info] of Object.entries(report.conversion.byOntologyType)) {
  console.log(`  ${type.padEnd(11)} ${pad(info.fields)} campi  →  ${info.nuextract}`)
}
console.log('')
console.log('  Le righe, come il template le chiede:')
for (const row of report.conversion.rows) {
  console.log(`         ⤷ ${row.id}`)
  console.log(`           ${row.template}`)
}
if (report.conversion.rowsWithSchema > report.conversion.rows.length) {
  console.log(
    `         ⤷ …e altre ${report.conversion.rowsWithSchema - report.conversion.rows.length}`
  )
}
console.log('')
console.log(`  ${pad(report.conversion.readyTypes)} tipi convertibili senza altre decisioni`)
console.log(
  `  ${pad(report.conversion.blockedTypes)} tipi fermi su almeno un campo «object» senza colonne`
)
rule()

if (broken > 0) {
  console.log(`\n${broken} violazioni di invariante: il registry è incoerente con sé stesso.\n`)
  process.exit(1)
}
console.log('\nInvarianti tutti rispettati.\n')
