import { z } from 'zod'
import { readRegistryJson } from './read-json'

export interface ClassSignalProfile {
  positive_phrases?: string[]
  negative_phrases?: string[]
  hard_negative_phrases?: string[]
  notes?: string
}

export interface ClassifierDefaultsV2 {
  auto_assign_threshold: number
  minimum_margin: number
  filename_only_max_score: number
  max_pages: number
  max_chars_per_page: number
  title_zone_chars: number
  negative_penalty: number
  hard_negative_penalty: number
  positive_signal_bonus: number
  corroboration_bonus: number
  max_corroboration_bonus: number
}

export interface ClassifierConfigV2 {
  version: string
  defaults: ClassifierDefaultsV2
  classes: Record<string, ClassSignalProfile>
}

export const CLASSIFIER_SIGNALS_FILE = 'classifier_signals_v2.json'

const phrases = z.array(z.string()).optional()

const configSchema: z.ZodType<ClassifierConfigV2> = z.object({
  version: z.string(),
  defaults: z.object({
    auto_assign_threshold: z.number(),
    minimum_margin: z.number(),
    filename_only_max_score: z.number(),
    max_pages: z.number().int().positive(),
    max_chars_per_page: z.number().int().positive(),
    title_zone_chars: z.number().int().positive(),
    negative_penalty: z.number(),
    hard_negative_penalty: z.number(),
    positive_signal_bonus: z.number(),
    corroboration_bonus: z.number(),
    max_corroboration_bonus: z.number()
  }),
  classes: z.record(
    z.string(),
    z.object({
      positive_phrases: phrases,
      negative_phrases: phrases,
      hard_negative_phrases: phrases,
      notes: z.string().optional()
    })
  )
})

export function loadClassifierConfigV2(directory: string): ClassifierConfigV2 {
  return readRegistryJson(directory, CLASSIFIER_SIGNALS_FILE, configSchema)
}
