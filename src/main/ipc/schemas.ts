import { z } from 'zod'

/**
 * Ogni canale valida il proprio input prima di toccare il database o Drive: il
 * renderer è codice fidato, ma il ponte IPC resta un confine e va trattato come tale.
 */
export const bboxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative()
})

export const documentFiltersSchema = z.object({
  status: z.enum(['NEEDS_REVIEW', 'APPROVED', 'REJECTED']).optional(),
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

export const reviewPayloadSchema = z.object({
  documentId: z.string().min(1),
  payload: z.object({
    decision: z.enum(['APPROVE', 'CORRECT', 'REJECT']),
    note: z.string().max(2000).optional()
  })
})

export const addAnnotationSchema = z.object({
  documentId: z.string().min(1),
  page: z.number().int().positive(),
  bbox: bboxSchema,
  kind: z.enum(['highlight', 'note']),
  note: z.string().max(2000).optional()
})

export const updateAnnotationSchema = z.object({
  id: z.string().min(1),
  bbox: bboxSchema.optional(),
  note: z.string().max(2000).nullable().optional()
})

export const searchSchema = z.object({ text: z.string().max(500) })
export const emptySchema = z.unknown().optional()
