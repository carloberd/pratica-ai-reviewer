import { createHash, randomBytes } from 'node:crypto'

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Coppia PKCE secondo RFC 7636. Serve perché un'app desktop non può custodire un
 * segreto: senza `code_verifier` chiunque intercetti il redirect sul loopback
 * potrebbe scambiare il codice con un token.
 */
export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(64))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/** Valore opaco contro il CSRF sul redirect. */
export function createState(): string {
  return base64url(randomBytes(24))
}
