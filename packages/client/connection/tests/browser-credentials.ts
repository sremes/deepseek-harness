import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** The record Connection signs browser cookies with. */
export const BROWSER_SESSION_KEY = credentialKey('client-connection', 'browser-session')
/** The record holding the durable operator bearer token. */
export const OPERATOR_TOKEN_KEY = credentialKey('client-connection', 'operator-token')

/** Mutable credential-record double for Connection authentication tests. */
export class RecordCredentials {
  private readonly records = new Map<string, CredentialRecord>()
  discardWrites = false
  reads = 0
  modifies = 0

  /** The browser-session record, which existing cases read and corrupt directly. */
  get record(): CredentialRecord | undefined {
    return this.records.get(BROWSER_SESSION_KEY)
  }

  set record(value: CredentialRecord | undefined) {
    this.store(BROWSER_SESSION_KEY, value)
  }

  /** One named record, for cases that care about a key other than the cookie secret. */
  recordFor(key: CredentialKey): CredentialRecord | undefined {
    return this.records.get(key)
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.records.get(key))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    const next = await mutate(this.records.get(key))
    if (this.discardWrites) return undefined
    // A mutator that returns undefined is the seam's "leave the record alone"
    // signal, not a deletion — deleting it here would break every reload.
    if (next !== undefined) this.store(key, next)
    return this.records.get(key)
  }

  deleteRecord(key?: CredentialKey): Promise<void> {
    if (key === undefined) this.records.clear()
    else this.records.delete(key)
    return Promise.resolve()
  }

  private store(name: CredentialKey, value: CredentialRecord | undefined): void {
    if (value === undefined) this.records.delete(name)
    else this.records.set(name, value)
  }
}

/** Provide the record operations Connection needs during authentication setup. */
export function provideBrowserCredentials(ctx: Context): void {
  ctx.provide('credentials', new RecordCredentials() as unknown as CredentialProvider)
}

/** The record double behind a test Context's `credentials` service. */
export function browserCredentialsOf(ctx: Context): RecordCredentials {
  const store = ctx.get('credentials')
  if (!(store instanceof RecordCredentials)) throw new Error('test Context has no record credentials')
  return store
}
