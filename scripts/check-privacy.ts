// Repository privacy check (run in CI):
// - nothing under the private drafts/ or submissions/ folders is tracked by Git;
// - no tracked image carries EXIF, XMP, or IPTC metadata (GPS location, camera,
//   timestamps). Images are recognized by content, not by file extension.
// Untracked local originals (e.g. in submissions/) are not checked.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findSensitiveMetadata, PRIVACY_FIX, sniffImageFormat } from './content/privacy.ts';
import { ROOT } from './content/paths.ts';

export const PRIVATE_DIRS = ['drafts/', 'submissions/'];

export async function checkTrackedFiles(root: string, files: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const file of files) {
    if (PRIVATE_DIRS.some((dir) => file.startsWith(dir))) {
      problems.push(
        `${file}: private drafts and submissions must not be committed; remove it with "git rm --cached"`,
      );
      continue;
    }
    const full = path.join(root, file);
    if (!existsSync(full)) continue; // deleted in the working tree
    const format = await sniffImageFormat(full);
    if (!format) continue;
    let found: string[];
    try {
      found = await findSensitiveMetadata(full);
    } catch (e) {
      problems.push(`${file}: cannot inspect ${format} image (${(e as Error).message})`);
      continue;
    }
    if (found.length > 0) problems.push(`${file}: contains ${found.join(', ')}; ${PRIVACY_FIX}`);
  }
  return problems;
}

if (import.meta.main) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const problems = await checkTrackedFiles(ROOT, files);
  for (const problem of problems) console.error(`error   ${problem}`);
  if (problems.length > 0) {
    console.error('\nPrivacy check failed.');
    process.exit(1);
  }
  console.log(`Privacy check passed (${files.length} tracked files).`);
}
