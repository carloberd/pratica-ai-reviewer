import { z } from 'zod'

/**
 * Ogni canale valida il proprio input prima di toccare il database o Drive: il
 * renderer è codice fidato, ma il ponte IPC resta un confine e va trattato come tale.
 */
export const documentFiltersSchema = z.object({
  status: z.enum(['NEEDS_REVIEW', 'REVIEWED', 'DISCARDED']).optional(),
  documentType: z.string().min(1).max(200).optional(),
  band: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  query: z.string().max(500).optional()
})

export const documentIdSchema = z.object({ id: z.string().min(1) })
export const documentRefSchema = z.object({ documentId: z.string().min(1) })

/** Chiave del registry `famiglia.tipo`, oppure uno slug scritto a mano nella UI. */
export const documentTypeSlugSchema = z
  .string()
  .min(2)
  .max(120)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'Usa solo lettere minuscole, numeri, punto, trattino e trattino basso.'
  )

export const setTypeSchema = z.object({
  id: z.string().min(1),
  documentType: documentTypeSlugSchema.nullable()
})

export const updateFieldSchema = z.object({
  documentId: z.string().min(1),
  fieldId: z.string().min(1),
  correctedValue: z.string().max(2000).nullable()
})

/** Righe dei campi ripetuti: stesso tetto dei campi singoli. */
export const addFieldItemSchema = z.object({
  documentId: z.string().min(1),
  fieldId: z.string().min(1),
  value: z.string().min(1).max(2000)
})

export const updateFieldItemSchema = z.object({
  documentId: z.string().min(1),
  itemId: z.string().min(1),
  correctedValue: z.string().max(2000).nullable()
})

export const removeFieldItemSchema = z.object({
  documentId: z.string().min(1),
  itemId: z.string().min(1),
  removed: z.boolean()
})

/** Il renderer manda l'azione scelta dal revisore: la `decision` la deriva il main. */
export const reviewSubmissionSchema = z.object({
  documentId: z.string().min(1),
  payload: z.object({
    action: z.enum(['SAVE', 'DISCARD']),
    note: z.string().max(2000).optional()
  })
})

export const fetchDriveFileSchema = z.object({
  driveFileId: z.string().min(1).max(200),
  force: z.boolean().default(false)
})

export const searchSchema = z.object({ text: z.string().max(500) })
export const emptySchema = z.unknown().optional()

/**
 * Ritaglio di pagina da passare all'OCR. Arriva dal renderer come immagine PNG già
 * rasterizzata: il tetto serve perché un'area grande a scala alta pesa, e oltre il
 * foglio intero non c'è niente da leggere.
 */
const MAX_OCR_IMAGE_BYTES = 16 * 1024 * 1024

export const ocrRegionSchema = z.object({
  image: z.custom<ArrayBuffer | Uint8Array>(
    (value) => {
      const bytes = imageByteLength(value)
      return bytes > 0 && bytes <= MAX_OCR_IMAGE_BYTES
    },
    { message: 'immagine non valida o troppo grande' }
  )
})

export function imageByteLength(value: unknown): number {
  if (value instanceof ArrayBuffer) return value.byteLength
  if (value instanceof Uint8Array) return value.byteLength
  return 0
}

// ---------------------------------------------------------------------------
// Mappa tipi ↔ dati da estrarre
// ---------------------------------------------------------------------------

/** Id di un campo dell'ontologia v2, es. `document.number`. */
const fieldIdSchema = z
  .string()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, 'Un id di campo è fatto di minuscole, numeri e punti.')

const fieldRoleSchema = z.enum(['required', 'core', 'optional', 'conditional'])

/**
 * Una correzione alla mappa «tipo ↔ dati da estrarre». Il ponte IPC è un confine: un id
 * di campo inventato o un ruolo che non esiste si ferma qui, prima di diventare una
 * decisione sul database che il motore applicherebbe a ogni documento.
 */
export const mapEditSchema = z.object({
  documentId: z.string().min(1),
  edit: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('REMOVE_FIELD'),
      documentType: documentTypeSlugSchema,
      fieldId: fieldIdSchema
    }),
    z.object({
      kind: z.literal('ADD_FIELD'),
      documentType: documentTypeSlugSchema,
      fieldId: fieldIdSchema,
      role: fieldRoleSchema
    }),
    z.object({
      kind: z.literal('SET_ROLE'),
      documentType: documentTypeSlugSchema,
      fieldId: fieldIdSchema,
      role: fieldRoleSchema
    }),
    z.object({
      kind: z.literal('RESTORE_FIELD'),
      documentType: documentTypeSlugSchema,
      fieldId: fieldIdSchema
    }),
    z.object({
      kind: z.literal('ADD_HINT_LABEL'),
      documentType: documentTypeSlugSchema,
      fieldId: fieldIdSchema,
      label: z.string().min(2).max(120)
    }),
    z.object({
      kind: z.literal('SET_CARDINALITY'),
      documentType: documentTypeSlugSchema,
      fieldId: fieldIdSchema,
      cardinality: z.enum(['one', 'many'])
    })
  ])
})

/** L'azione della cronologia da annullare. */
export const profileActionSchema = z.object({ actionId: z.string().uuid() })

/** Lo stesso annullamento, fatto dal documento aperto che poi si rielabora. */
export const mapRevertSchema = z.object({
  documentId: z.string().min(1),
  actionId: z.string().uuid()
})
