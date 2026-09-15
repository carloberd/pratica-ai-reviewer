import type { ConfidenceBand } from './types'

/**
 * Bande di confidence. Euristica dichiarata della v1, da calibrare sui documenti reali.
 * HIGH >= 0.9, MEDIUM >= 0.75, LOW sotto.
 */
export const BAND_THRESHOLDS = { HIGH: 0.9, MEDIUM: 0.75 } as const

export function bandOf(confidence: number): ConfidenceBand {
  if (confidence >= BAND_THRESHOLDS.HIGH) return 'HIGH'
  if (confidence >= BAND_THRESHOLDS.MEDIUM) return 'MEDIUM'
  return 'LOW'
}

/** Confidence di un documento = media dei campi precompilati. Nessun campo = 0. */
export function averageConfidence(values: number[]): number {
  if (values.length === 0) return 0
  const sum = values.reduce((acc, v) => acc + v, 0)
  return Math.round((sum / values.length) * 1e4) / 1e4
}

/** Soglia minima per assegnare automaticamente un documentType. */
export const TYPE_MATCH_THRESHOLD = 0.75
