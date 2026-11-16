'use strict';

const crypto = require('crypto');

function encryptionKey(value = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Token encryption key is not configured.');
  const key = /^[a-f0-9]{64}$/i.test(value.trim())
    ? Buffer.from(value.trim(), 'hex')
    : Buffer.from(value.trim(), 'base64');
  if (key.length !== 32) throw new Error('Token encryption key must encode exactly 32 random bytes as 64 hex characters or base64.');
  return key;
}

function encryptTokens(tokens, keyValue) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}

function decryptTokens(envelope, keyValue) {
  const record = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (!record || record.version !== 1) throw new Error('Unsupported encrypted Google token record.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keyValue), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  const clear = Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(clear);
}

module.exports = { encryptTokens, decryptTokens, encryptionKey };
