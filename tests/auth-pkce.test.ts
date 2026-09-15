import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createPkcePair, createState } from '../src/main/auth/pkce'

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('PKCE', () => {
  it('produce un challenge S256 coerente con il verifier', () => {
    const pair = createPkcePair()
    expect(pair.method).toBe('S256')
    expect(pair.challenge).toBe(base64url(createHash('sha256').update(pair.verifier).digest()))
  })

  it('usa solo caratteri ammessi da RFC 7636 e la lunghezza prevista', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it('non ripete verifier né state', () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => createPkcePair().verifier))
    const states = new Set(Array.from({ length: 50 }, () => createState()))
    expect(verifiers.size).toBe(50)
    expect(states.size).toBe(50)
  })
})
