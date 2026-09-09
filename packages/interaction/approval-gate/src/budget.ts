/**
 * Daily judge spend cap: one JSON counter file under the task home, rolled
 * per UTC date. Real filesystem against tmp homes in tests — hermetic
 * without fakes.
 *
 * @module @deepseek-ai/dsh-approval-gate/budget
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Counter file name inside the `meta` directory of the task home. */
export const BUDGET_FILE = 'approver-budget.json'

/**
 * Read and bump the daily counter. Missing or corrupt files start a fresh
 * day (a broken counter must not wedge approvals); a spent budget refuses
 * without writing.
 *
 * @param home - harness home holding the `meta` directory.
 * @param maxPerDay - judge calls allowed per UTC date.
 * @param now - current time in millis (defaults to live clock).
 * @returns true when a call may proceed (and consumes one unit).
 */
export async function takeBudget(home: string, maxPerDay: number, now: number = Date.now()): Promise<boolean> {
  const today = new Date(now).toISOString().slice(0, 10)
  const file = join(home, 'meta', BUDGET_FILE)
  let state: { date?: unknown; count?: unknown } = {}
  try {
    state = JSON.parse(await readFile(file, 'utf8')) as { date?: unknown; count?: unknown }
  } catch {
    state = {}
  }
  const count = state.date === today && typeof state.count === 'number' ? state.count : 0
  if (count >= maxPerDay) return false
  await mkdir(join(home, 'meta'), { recursive: true })
  await writeFile(file, JSON.stringify({ date: today, count: count + 1 }))
  return true
}
