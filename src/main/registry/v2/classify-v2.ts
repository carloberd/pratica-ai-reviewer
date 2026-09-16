import type { RegistryAlias } from '../index'
import type { ClassifierConfigV2 } from './config'
import { normalizeClassifierTextV2 } from './normalize'

export type MatchEvidenceSource =
  | 'title-zone'
  | 'page'
  | 'filename'
  | 'positive-signal'
  | 'negative-signal'
  | 'hard-negative-signal'

export interface MatchEvidenceV2 {
  source: MatchEvidenceSource
  phrase: string
  delta: number
}

export interface TypeCandidateV2 {
  documentType: string
  score: number
  evidence: MatchEvidenceV2[]
}

export interface TypeMatchV2 {
  documentType: string
  confidence: number
  margin: number
  runnerUp: { documentType: string; confidence: number } | null
  evidence: MatchEvidenceV2[]
  candidates: TypeCandidateV2[]
  decision: 'ASSIGN' | 'UNKNOWN'
  reason: 'OK' | 'BELOW_THRESHOLD' | 'LOW_MARGIN' | 'FILENAME_ONLY' | 'HARD_NEGATIVE' | 'NO_SIGNAL'
}

interface CandidateAccumulator {
  documentType: string
  score: number
  evidence: MatchEvidenceV2[]
  contentEvidence: boolean
  hardNegative: boolean
  matchedPhrases: Set<string>
}

function phraseSpecificity(phrase: string): number {
  const normalized = normalizeClassifierTextV2(phrase)
  const words = normalized.split(' ').filter(Boolean)
  const wordBonus = Math.min(0.12, Math.max(0, words.length - 1) * 0.025)
  const charBonus = Math.min(0.06, normalized.length / 300)
  return wordBonus + charBonus
}

function hasPhrase(haystackNormalized: string, phrase: string): boolean {
  const needle = ` ${normalizeClassifierTextV2(phrase)} `
  return needle.trim().length > 0 && ` ${haystackNormalized} `.includes(needle)
}

function getCandidate(
  map: Map<string, CandidateAccumulator>,
  documentType: string
): CandidateAccumulator {
  let c = map.get(documentType)
  if (!c) {
    c = {
      documentType,
      score: 0,
      evidence: [],
      contentEvidence: false,
      hardNegative: false,
      matchedPhrases: new Set()
    }
    map.set(documentType, c)
  }
  return c
}

function addEvidence(
  c: CandidateAccumulator,
  source: MatchEvidenceSource,
  phrase: string,
  delta: number,
  content = true
): void {
  const normalized = normalizeClassifierTextV2(phrase)
  const key = `${source}:${normalized}`
  if (c.matchedPhrases.has(key)) return
  c.matchedPhrases.add(key)
  c.score += delta
  c.evidence.push({ source, phrase, delta })
  if (content && source !== 'filename') c.contentEvidence = true
}

/**
 * Deterministic multi-signal classifier.
 *
 * Design:
 * - filename is corroboration only and can never auto-assign by itself;
 * - content aliases are weighted by specificity and position;
 * - multiple independent phrases add bounded corroboration;
 * - negative / hard-negative signals penalize confusable classes;
 * - assignment requires both score threshold and margin over runner-up;
 * - returns top candidates + reasons for auditability.
 */
export function matchDocumentTypeV2(input: {
  aliases: RegistryAlias[]
  pages: string[]
  filename: string
  config: ClassifierConfigV2
}): TypeMatchV2 {
  const { aliases, config } = input
  const d = config.defaults
  const pages = input.pages
    .slice(0, d.max_pages)
    .map((p) => normalizeClassifierTextV2(p.slice(0, d.max_chars_per_page)))
  const firstPage = pages[0] ?? ''
  const titleZone = firstPage.slice(0, d.title_zone_chars)
  const allContent = pages.join(' ')
  const filename = normalizeClassifierTextV2(input.filename)

  const map = new Map<string, CandidateAccumulator>()

  for (const alias of aliases) {
    const phrase = alias.phrase
    const c = getCandidate(map, alias.documentType)
    const specificity = phraseSpecificity(phrase)

    if (hasPhrase(titleZone, phrase)) {
      addEvidence(c, 'title-zone', phrase, 0.62 + specificity)
    } else if (hasPhrase(allContent, phrase)) {
      addEvidence(c, 'page', phrase, 0.48 + specificity)
    }

    if (hasPhrase(filename, phrase)) {
      addEvidence(c, 'filename', phrase, 0.16 + Math.min(0.08, specificity), false)
    }
  }

  // Configurable evidence learned from real reviewed documents.
  for (const [documentType, profile] of Object.entries(config.classes)) {
    const c = getCandidate(map, documentType)

    for (const phrase of profile.positive_phrases ?? []) {
      if (hasPhrase(allContent, phrase)) {
        addEvidence(
          c,
          'positive-signal',
          phrase,
          d.positive_signal_bonus + phraseSpecificity(phrase)
        )
      }
    }
    for (const phrase of profile.negative_phrases ?? []) {
      if (hasPhrase(allContent, phrase)) {
        addEvidence(c, 'negative-signal', phrase, -d.negative_penalty)
      }
    }
    for (const phrase of profile.hard_negative_phrases ?? []) {
      if (hasPhrase(allContent, phrase)) {
        addEvidence(c, 'hard-negative-signal', phrase, -d.hard_negative_penalty)
        c.hardNegative = true
      }
    }
  }

  // Bounded corroboration for distinct positive content signals.
  for (const c of map.values()) {
    const positiveContentCount = c.evidence.filter(
      (e) => e.delta > 0 && e.source !== 'filename'
    ).length
    if (positiveContentCount > 1) {
      const bonus = Math.min(
        d.max_corroboration_bonus,
        (positiveContentCount - 1) * d.corroboration_bonus
      )
      c.score += bonus
      c.evidence.push({ source: 'positive-signal', phrase: '__corroboration__', delta: bonus })
    }

    // Keep scores interpretable as confidence-like values.
    c.score = Math.max(0, Math.min(0.99, c.score))
  }

  const ranked = [...map.values()]
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.documentType.localeCompare(b.documentType))

  if (ranked.length === 0) {
    return {
      documentType: '',
      confidence: 0,
      margin: 0,
      runnerUp: null,
      evidence: [],
      candidates: [],
      decision: 'UNKNOWN',
      reason: 'NO_SIGNAL'
    }
  }

  const top = ranked[0]!
  const second = ranked[1] ?? null
  const margin = second ? top.score - second.score : top.score
  const candidates = ranked.slice(0, 5).map((c) => ({
    documentType: c.documentType,
    score: c.score,
    evidence: c.evidence
  }))

  let reason: TypeMatchV2['reason'] = 'OK'
  if (top.hardNegative) reason = 'HARD_NEGATIVE'
  else if (!top.contentEvidence) reason = 'FILENAME_ONLY'
  else if (top.score < d.auto_assign_threshold) reason = 'BELOW_THRESHOLD'
  else if (margin < d.minimum_margin) reason = 'LOW_MARGIN'

  const decision = reason === 'OK' ? 'ASSIGN' : 'UNKNOWN'

  return {
    documentType: decision === 'ASSIGN' ? top.documentType : '',
    confidence: top.score,
    margin,
    runnerUp: second ? { documentType: second.documentType, confidence: second.score } : null,
    evidence: top.evidence,
    candidates,
    decision,
    reason
  }
}
