import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM encryption for refresh_token at rest. Key from B24_TOKEN_ENC_KEY
// (32 bytes, base64). Blob format: base64(iv):base64(tag):base64(ciphertext).

/** Decode a base64 key and assert it is 32 bytes. */
export function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) {
    throw new Error(`B24_TOKEN_ENC_KEY must decode to 32 bytes, got ${key.length}`)
  }
  return key
}

export function encryptSecret(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decryptSecret(blob: string, keyB64: string): string {
  const key = decodeKey(keyB64)
  const [ivB64, tagB64, dataB64] = blob.split(':')
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('secretCrypto: malformed blob')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}
