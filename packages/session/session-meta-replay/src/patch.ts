/**
 * Candidate-overlay `--patch` generator for the M3 L2/L3 replay arms
 * (Plan-V1 §4.1 + Q15): renders the patch file that mounts one draft skill
 * directory as an extra `skill-filesystem` root, so the candidate arm runs
 * with the draft discoverable and the baseline arm runs without it.
 *
 * @module @deepseek-ai/dsh-session-meta-replay/patch
 */

import { writeFileSync } from 'node:fs'

/** Patch id addressing the filesystem skill provider in every shipped profile. */
export const SKILL_FILESYSTEM_PATCH_ID = 'skill-filesystem'

/**
 * Write a deterministic dsh `--patch` file mounting one skill-overlay
 * directory. The patch sets `customSkillDirs` to exactly the overlay, so a
 * replay arm booted with it sees the draft and nothing else beyond the
 * profile defaults. Same inputs twice render byte-identical output.
 *
 * @param overlayDir - candidate skill-overlay directory to mount; must be non-empty.
 * @param file - patch file path to write.
 * @returns the patch file path handed back for the delegate run function.
 */
export function generateSkillOverlayPatch(overlayDir: string, file: string): string {
  if (overlayDir.trim() === '') {
    throw new Error(`session-meta-replay: refusing to mount an empty skill-overlay directory (got ${JSON.stringify(overlayDir)})`)
  }
  writeFileSync(file, `- id: ${SKILL_FILESYSTEM_PATCH_ID}\n  config:\n    customSkillDirs:\n      - ${JSON.stringify(overlayDir)}\n`)
  return file
}
