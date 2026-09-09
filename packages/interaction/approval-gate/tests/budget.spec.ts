/**
 * Budget specs: the daily counter starts fresh, increments, refuses past
 * the cap without writing, rolls on date change, and survives corrupt
 * files — all against tmp homes, hermetic without fakes.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { BUDGET_FILE, takeBudget } from '../src/budget.ts'

const DAY_MS = 24 * 3600 * 1000
const NOON = Date.UTC(2026, 8, 9, 12, 0, 0)

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Fresh tmp home for one test.
 *
 * @returns the home path.
 */
async function freshHome(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-gate-budget-'))
  if (root === undefined) throw new Error('tmp root missing')
  return root
}

describe('takeBudget', () => {
  it('starts fresh and consumes one unit per call', async () => {
    const home = await freshHome()
    await expect(takeBudget(home, 2, NOON)).resolves.toBe(true)
    await expect(takeBudget(home, 2, NOON)).resolves.toBe(true)
    const stored = JSON.parse(await readFile(join(home, 'meta', BUDGET_FILE), 'utf8')) as { count?: unknown }
    expect(stored).toMatchObject({ count: 2 })
  })

  it('refuses past the cap', async () => {
    const home = await freshHome()
    await expect(takeBudget(home, 1, NOON)).resolves.toBe(true)
    await expect(takeBudget(home, 1, NOON)).resolves.toBe(false)
  })

  it('rolls the counter on date change', async () => {
    const home = await freshHome()
    await expect(takeBudget(home, 1, NOON)).resolves.toBe(true)
    await expect(takeBudget(home, 1, NOON)).resolves.toBe(false)
    await expect(takeBudget(home, 1, NOON + DAY_MS)).resolves.toBe(true)
  })

  it('resets corrupt or wrong-shaped files instead of wedging', async () => {
    const home = await freshHome()
    const file = join(home, 'meta', BUDGET_FILE)
    mkdirSync(join(home, 'meta'), { recursive: true })
    writeFileSync(file, 'not json{')
    await expect(takeBudget(home, 1, NOON)).resolves.toBe(true)
    writeFileSync(file, JSON.stringify({ date: '2026-09-09', count: 'many' }))
    await expect(takeBudget(home, 1, NOON)).resolves.toBe(true)
  })
})
