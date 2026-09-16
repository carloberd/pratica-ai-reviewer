import { describe, expect, it } from 'vitest'
import {
  bakedCredentials,
  parseEngine,
  parseEnvFile,
  resolveCredentials,
  resolveEngines
} from '../src/main/config'
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

describe('precedenza delle credenziali', () => {
  const baked = { clientId: 'baked.apps.googleusercontent.com', clientSecret: 'GOCSPX-baked' }

  it('le variabili d ambiente vincono su tutto', () => {
    expect(
      resolveCredentials({
        env: { GOOGLE_CLIENT_ID: 'env-id', GOOGLE_CLIENT_SECRET: 'env-secret' },
        envFiles: [{ GOOGLE_CLIENT_ID: 'file-id', GOOGLE_CLIENT_SECRET: 'file-secret' }],
        baked
      })
    ).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' })
  })

  it('il file .env vince su quelle cucite nel pacchetto', () => {
    expect(
      resolveCredentials({
        env: {},
        envFiles: [{ GOOGLE_CLIENT_ID: 'file-id', GOOGLE_CLIENT_SECRET: 'file-secret' }],
        baked
      })
    ).toEqual({ clientId: 'file-id', clientSecret: 'file-secret' })
  })

  it('senza nient altro usa quelle cucite nel pacchetto', () => {
    expect(resolveCredentials({ env: {}, envFiles: [], baked })).toEqual(baked)
  })

  it('senza nessuna sorgente non inventa credenziali', () => {
    expect(resolveCredentials({ env: {}, envFiles: [], baked: null })).toBeNull()
  })

  /**
   * Un .env a metà non deve mescolarsi con quelle del pacchetto: id di un client e
   * secret di un altro produrrebbero un `invalid_client` incomprensibile.
   */
  it('una coppia incompleta non si mescola fra sorgenti diverse', () => {
    expect(
      resolveCredentials({ env: { GOOGLE_CLIENT_ID: 'solo-id' }, envFiles: [], baked: null })
    ).toBeNull()
  })

  it('il primo file .env che ha la coppia completa vince sui successivi', () => {
    expect(
      resolveCredentials({
        env: {},
        envFiles: [
          { GOOGLE_CLIENT_ID: 'primo-id', GOOGLE_CLIENT_SECRET: 'primo-secret' },
          { GOOGLE_CLIENT_ID: 'secondo-id', GOOGLE_CLIENT_SECRET: 'secondo-secret' }
        ],
        baked: null
      })
    ).toEqual({ clientId: 'primo-id', clientSecret: 'primo-secret' })
  })

  it('fuori dal bundle non ci sono credenziali cucite', () => {
    expect(bakedCredentials()).toBeNull()
  })
})

describe('motori di classificazione e di estrazione', () => {
  it('senza variabili vale v2 per entrambi', () => {
    expect(resolveEngines({ env: {}, envFiles: [] })).toEqual({
      classifier: 'v2',
      extraction: 'v2'
    })
  })

  it('v1 si sceglie per ciascun motore separatamente', () => {
    expect(resolveEngines({ env: { EXTRACTION_ENGINE: 'v1' }, envFiles: [] })).toEqual({
      classifier: 'v2',
      extraction: 'v1'
    })
  })

  it('stessa precedenza delle credenziali: ambiente, poi i file .env in ordine', () => {
    expect(
      resolveEngines({
        env: { CLASSIFIER_ENGINE: 'v1' },
        envFiles: [
          { CLASSIFIER_ENGINE: 'v2', EXTRACTION_ENGINE: 'v1' },
          { EXTRACTION_ENGINE: 'v2' }
        ]
      })
    ).toEqual({ classifier: 'v1', extraction: 'v1' })
  })

  it('un valore vuoto non nasconde quello del file successivo', () => {
    expect(
      resolveEngines({
        env: { CLASSIFIER_ENGINE: '' },
        envFiles: [{ CLASSIFIER_ENGINE: ' ' }, { CLASSIFIER_ENGINE: 'v1' }]
      }).classifier
    ).toBe('v1')
  })

  it('tollera maiuscole e spazi', () => {
    expect(parseEngine('EXTRACTION_ENGINE', ' V1 ')).toBe('v1')
  })

  it('un valore sconosciuto è un errore d avvio, non un ripiego silenzioso', () => {
    expect(() => parseEngine('EXTRACTION_ENGINE', 'v3')).toThrow(
      'EXTRACTION_ENGINE=v3 non è valido: i valori ammessi sono v1 e v2.'
    )
  })
})
