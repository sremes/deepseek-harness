/**
 * Headless steering ingest (Plan-V1 §3.3): the orchestrator writes correction
 * records to `$DSH_HOME/meta/steering/<session-id>.json`; the offline loop
 * reads them back as the second steering source next to in-session
 * user/messages. Files are validated strictly and moved to `processed/`
 * after a successful evaluation so a record is never applied twice.
 */

import { join } from 'node:path'
import type { SteeringRecord } from './types.ts'

/** Raw steering file shape; validated field by field, never cast blindly. */
interface SteeringFileRaw {
  readonly original_task?: unknown
  readonly correction?: unknown
  readonly intent_hint?: unknown
  readonly verified_by?: unknown
}

/**
 * Validate one parsed steering file. Pure: every branch is unit-testable
 * without a filesystem.
 *
 * @param sessionId - session the record claims to correct; must match the file name.
 * @param raw - parsed JSON value from the steering file.
 * @returns the validated record.
 */
export function parseSteeringFile(sessionId: string, raw: unknown): SteeringRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`session-meta: steering record for ${sessionId} must be a JSON object`)
  }
  const file = raw as SteeringFileRaw
  if (typeof file.original_task !== 'string' || file.original_task.trim().length === 0) {
    throw new Error(`session-meta: steering record for ${sessionId} needs a non-empty original_task`)
  }
  if (typeof file.correction !== 'string' || file.correction.trim().length === 0) {
    throw new Error(`session-meta: steering record for ${sessionId} needs a non-empty correction`)
  }
  if (file.intent_hint !== undefined && typeof file.intent_hint !== 'string') {
    throw new Error(`session-meta: steering record for ${sessionId} has a non-string intent_hint`)
  }
  if (file.verified_by !== undefined && typeof file.verified_by !== 'string') {
    throw new Error(`session-meta: steering record for ${sessionId} has a non-string verified_by`)
  }
  return {
    sessionId,
    originalTask: file.original_task,
    correction: file.correction,
    ...(file.intent_hint === undefined ? {} : { intentHint: file.intent_hint }),
    ...(file.verified_by === undefined ? {} : { verifiedBy: file.verified_by }),
  }
}

/**
 * Canonical path of one session's steering record.
 *
 * @param home - resolved harness home.
 * @param sessionId - session the record corrects.
 */
export function steeringFilePath(home: string, sessionId: string): string {
  return join(home, 'meta', 'steering', `${sessionId}.json`)
}

/**
 * Directory holding consumed steering records.
 *
 * @param home - resolved harness home.
 */
export function processedSteeringDir(home: string): string {
  return join(home, 'meta', 'steering', 'processed')
}
