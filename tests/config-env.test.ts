import { describe, expect, it } from 'vitest'
import { parseEnvFile } from '../src/main/config'
import { ReviewerError, redact, toIpcError } from '../src/main/errors'

describe('parsing del file .env', () => {
  it('legge chiavi, commenti e virgolette', () => {
    const parsed = parseEnvFile(
      [
        '# credenziali OAuth',
        'GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com',
        '  GOOGLE_CLIENT_SECRET = "GOCSPX-segreto"  ',
        '',
        'VUOTO=',
        'SENZA_UGUALE',
        "APICI='valore'"
      ].join('\n')
    )

    expect(parsed).toEqual({
      GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-segreto',
      VUOTO: '',
      APICI: 'valore'
    })
  })

  it('conserva un valore che contiene un uguale', () => {
    expect(parseEnvFile('TOKEN=abc=def==')).toEqual({ TOKEN: 'abc=def==' })
  })
})

describe('redazione delle credenziali', () => {
  it('toglie access token, refresh token, client id, secret e JWT', () => {
    const message = [
      'richiesta fallita con Authorization: Bearer ya29.a0AfB_byC-token-lungo',
      'refresh 1//04abcdefghijklmnopqrstuvwxyz',
      'client 123456789012-abcdefghijklmnop.apps.googleusercontent.com',
      'secret GOCSPX-abcdef123456',
      'id_token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.firma-finta'
    ].join(' ')

    const clean = redact(message)

    expect(clean).not.toMatch(/ya29\./)
    expect(clean).not.toMatch(/1\/\/04/)
    expect(clean).not.toMatch(/googleusercontent/)
    expect(clean).not.toMatch(/GOCSPX-/)
    expect(clean).not.toMatch(/eyJ/)
    expect(clean).toContain('[redatto]')
  })

  it('lascia intatto un messaggio senza credenziali', () => {
    expect(redact('Documento non trovato.')).toBe('Documento non trovato.')
  })
})

describe('errori verso il renderer', () => {
  it('conserva il codice di un ReviewerError', () => {
    expect(toIpcError(new ReviewerError('NOT_FOUND', 'Documento non trovato.'))).toEqual({
      code: 'NOT_FOUND',
      message: 'Documento non trovato.'
    })
  })

  it('degrada un errore qualunque a INTERNAL senza stack', () => {
    const result = toIpcError(new Error('crash con token ya29.segretissimo'))
    expect(result.code).toBe('INTERNAL')
    expect(result.message).toBe('crash con token [redatto]')
    expect(Object.keys(result).sort()).toEqual(['code', 'message'])
  })

  it('gestisce un throw che non è un Error', () => {
    expect(toIpcError('boom')).toEqual({ code: 'INTERNAL', message: 'Errore imprevisto.' })
  })
})
