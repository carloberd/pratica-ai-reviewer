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
 * Il registry si scrive altrove e qui non si tocca niente: entrano due file, esce un
 * rapporto.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_DIR = 'resources/registry'

const FIELDS_FILE = 'fields.json'
const DOCUMENT_FIELDS_FILE = 'document_fields.json'

/** I ruoli con cui un tipo elenca i campi che vuole. */
const ROLE_KEYS = ['required_fields', 'optional_fields']

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
  'identifier|vin': ['vin']
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
  'vin'
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
  'vin'
])

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

/** I campi che un tipo chiede, senza distinguere il ruolo. */
const fieldsOf = (type) => new Set(ROLE_KEYS.flatMap((key) => documentTypes[type]?.[key] ?? []))

/** Quante volte ogni campo è chiesto da un tipo. */
const usage = new Map()
for (const type of typeIds) {
  for (const field of fieldsOf(type)) usage.set(field, (usage.get(field) ?? 0) + 1)
}

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
  for (const key of ROLE_KEYS) {
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
  for (const key of ROLE_KEYS) {
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

// ─── Avanzamento ─────────────────────────────────────────────────────────────

const objectFields = fieldIds.filter((id) => fields[id].type === 'object')
const blockedTypes = typeIds.filter((type) =>
  [...fieldsOf(type)].some((f) => fields[f]?.type === 'object')
)
gap(
  'campi «object» senza schema di riga',
  objectFields.length,
  `bloccano ${blockedTypes.length} tipi su ${typeIds.length}: senza le colonne non esiste una conversione`,
  objectFields
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

const attributesRequired = []
for (const type of typeIds) {
  for (const field of documentTypes[type].required_fields ?? []) {
    if (ATTRIBUTE_FIELDS.includes(field)) attributesRequired.push(`${type}: ${field}`)
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

const percentages = fieldIds.filter((id) => fields[id].format === 'percentage')
gap(
  'percentuali senza convenzione di scala',
  percentages.length,
  '22 o 0,22? finché non sta scritto, metà dei documenti va in un modo e metà nell’altro',
  percentages
)

const openEnums = fieldIds.filter((id) => fields[id].format === 'currency')
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

const constantFlag = fieldIds.every((id) => fields[id].evidence_required === true)
gap(
  'campi con «evidence_required» sempre uguale',
  constantFlag ? fieldIds.length : 0,
  constantFlag
    ? 'vale true su tutti: il campo non distingue niente'
    : 'il campo distingue qualcosa',
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
    byOntologyType: Object.fromEntries(
      Object.entries(byOntologyType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => [t, { fields: n, nuextract: NUEXTRACT_TYPE_OF[t] ?? 'da definire' }])
    )
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
console.log(`  ${pad(report.conversion.readyTypes)} tipi convertibili senza altre decisioni`)
console.log(`  ${pad(report.conversion.blockedTypes)} tipi fermi su almeno un campo «object»`)
rule()

if (broken > 0) {
  console.log(`\n${broken} violazioni di invariante: il registry è incoerente con sé stesso.\n`)
  process.exit(1)
}
console.log('\nInvarianti tutti rispettati.\n')
