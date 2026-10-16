// Repository privacy check (run in CI):
// - nothing under the git-ignored private/ folder (drafts, raw submissions,
//   contributor contact details) is tracked by Git;
// - no tracked image carries EXIF, XMP, or IPTC metadata (GPS location, camera,
//   timestamps). Images are recognized by content, not by file extension;
// - no public content text (content/**/*.json, *.md) contains an email address
//   or a Tally file link (which carries an access token);
// - no tag in a tag registry (content/tags.json, fixtures/tags.json) carries
//   contact details: tag words appear on every restaurant that uses them.
// Untracked local files (e.g. originals in private/submissions/) are not checked.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { tagRegistrySchema } from '../shared/content/schema.ts';
import {
  findContactDetails,
  findSensitiveMetadata,
  PRIVACY_FIX,
  sniffImageFormat,
  tagRegistryProblems,
} from './content/privacy.ts';
import { ROOT } from './content/paths.ts';

export const PRIVATE_DIRS = ['private/'];

export async function checkTrackedFiles(root: string, files: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const file of files) {
    if (PRIVATE_DIRS.some((dir) => file.startsWith(dir))) {
      problems.push(
        `${file}: files in private/ (drafts, submissions, contact details) must not be committed; remove it with "git rm --cached"`,
      );
      continue;
    }
    const full = path.join(root, file);
    if (!existsSync(full)) continue; // deleted in the working tree
    if (/^(content|fixtures)\/tags\.json$/.test(file)) {
      const parsed = tagRegistrySchema.safeParse(JSON.parse(await readFile(full, 'utf8')));
      if (!parsed.success) {
        problems.push(`${file}: not a valid tag registry; run npm run content:check`);
        continue;
      }
      for (const found of tagRegistryProblems(parsed.data).unsafe) {
        problems.push(`${file}: ${found}; tags must not carry contact details`);
      }
      if (file.startsWith('fixtures/')) continue;
    }
    if (file.startsWith('content/') && /\.(json|md)$/.test(file)) {
      const found = findContactDetails(await readFile(full, 'utf8')).filter((f) =>
        /^(email address|Tally link)/.test(f),
      );
      if (found.length > 0)
        problems.push(
          `${file}: contains ${found.join(', ')}; public content must not carry contact details`,
        );
      continue;
    }
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
