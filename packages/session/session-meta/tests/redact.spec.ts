/**
 * Unit coverage for the meta-store redaction: every pattern, bound, and
 * fallback. Secrets must never survive; legitimate content must pass
 * through byte-identical.
 */

import { describe, expect, it } from 'vitest'
import { redactString, redactValue } from '../src/redact.ts'

describe('redactString', () => {
  it('passes clean text through untouched', () => {
    expect(redactString('hello world', {})).toEqual({ text: 'hello world', redactions: 0 })
  })

  it('scrubs known token prefixes', () => {
    expect(redactString('key sk-abc123XYZ4567 end', {}).text).toBe('key [REDACTED:sk] end')
    expect(redactString('tok ghp_abcdefgh12345678', {}).text).toBe('tok [REDACTED:ghp]')
    expect(redactString('tok gho_abcdefgh12345678', {}).text).toBe('tok [REDACTED:gho]')
    expect(redactString('tok github_pat_abcdefgh12345678', {}).text).toBe('tok [REDACTED:github-pat]')
    expect(redactString('tok xoxb-12345678-abcdefghi', {}).text).toBe('tok [REDACTED:slack]')
    expect(redactString('id AKIAIOSFODNN7EXAMPLE', {}).text).toBe('id [REDACTED:aws-key]')
    expect(redactString('auth Bearer abcdef1234567890', {}).text).toBe('auth Bearer [REDACTED]')
  })

  it('scrubs PEM blocks wholesale', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg==\n-----END PRIVATE KEY-----'
    const { text, redactions } = redactString(`before ${pem} after`, {})
    expect(text).toBe('before [REDACTED:PEM] after')
    expect(redactions).toBeGreaterThan(0)
  })

  it('scrubs secret assignments but keeps the key name', () => {
    expect(redactString('api_key=supersecret123', {}).text).toBe('api_key=[REDACTED]')
    expect(redactString('password: hunter2!', {}).text).toBe('password: [REDACTED]')
  })

  it('normalizes home and cwd paths', () => {
    const { text, redactions } = redactString('read /home/u/project/file.ts', { home: '/home/u', cwd: '/home/u/project' })
    expect(text).toBe('read ~/project/file.ts')
    expect(redactions).toBeGreaterThanOrEqual(1)
    expect(redactString('cd /home/u/project', { cwd: '/home/u/project' }).text).toBe('cd $CWD')
  })

  it('skips empty home and cwd without counting', () => {
    expect(redactString('plain', { home: '', cwd: '' })).toEqual({ text: 'plain', redactions: 0 })
  })

  it('truncates overlong strings with a marker', () => {
    const { text, redactions } = redactString('a'.repeat(5000), { maxStringChars: 100 })
    expect(text).toBe(`${'a'.repeat(100)}…[truncated 4900]`)
    expect(redactions).toBe(1)
  })
})

describe('redactValue', () => {
  it('passes scalars through', () => {
    expect(redactValue(null, {})).toEqual({ value: null, redactions: 0 })
    expect(redactValue(42, {})).toEqual({ value: 42, redactions: 0 })
    expect(redactValue(true, {})).toEqual({ value: true, redactions: 0 })
  })

  it('scrubs nested structures and counts every hit', () => {
    const { value, redactions } = redactValue(
      { args: { token: 'sk-abc123XYZ4567' }, list: ['ok', 'ghp_abcdefgh12345678'] },
      {},
    )
    expect(value).toEqual({ args: { token: '[REDACTED:sk]' }, list: ['ok', '[REDACTED:ghp]'] })
    expect(redactions).toBe(2)
  })

  it('caps arrays and marks the cut', () => {
    const { value, redactions } = redactValue([1, 2, 3, 4], { maxArrayItems: 2 })
    expect(value).toEqual([1, 2, '…[truncated 2 items]'])
    expect(redactions).toBe(1)
  })

  it('stops at the depth bound', () => {
    const { value, redactions } = redactValue({ a: { b: 1 } }, { maxDepth: 0 })
    expect(value).toEqual({ a: '[REDACTED:depth]' })
    expect(redactions).toBe(1)
  })

  it('replaces non-plain objects with a type tag', () => {
    expect(redactValue(() => undefined, {}).value).toBe('[REDACTED:function]')
    expect(redactValue(Symbol('s'), {}).value).toBe('[REDACTED:symbol]')
    expect(redactValue(undefined, {}).value).toBe('[REDACTED:undefined]')
    expect(redactValue(new Date(0), {}).value).toBe('[REDACTED:object]')
  })
})
