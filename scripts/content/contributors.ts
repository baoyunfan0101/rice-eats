// Contributor database: public identities in content/contributors.json
// ({ id, name }), and pending contributors plus contact details in the
// git-ignored private/contributors.json. Restaurants reference contributors by id.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  privateContributorsSchema,
  publicContributorsSchema,
  type PrivateContributors,
  type PublicContributor,
} from '../../shared/content/schema.ts';
import { IntakeError } from './intake.ts';

export interface ContributorFiles {
  publicFile: string;
  privateFile: string;
}

export async function loadContributors({ publicFile, privateFile }: ContributorFiles) {
  const publicList: PublicContributor[] = existsSync(publicFile)
    ? publicContributorsSchema.parse(JSON.parse(await readFile(publicFile, 'utf8')))
    : [];
  const privateRecords: PrivateContributors = existsSync(privateFile)
    ? privateContributorsSchema.parse(JSON.parse(await readFile(privateFile, 'utf8')))
    : {};
  return { publicList, privateRecords };
}

const normalize = (text: string) => text.normalize('NFKC').trim().toLowerCase();

export interface ContributorMatch {
  id: string;
  name?: string;
  public: boolean;
  /** True when a private email or contact detail matched (the detail itself is not returned). */
  matchedContact: boolean;
}

/** Finds existing contributors by name, email, or contact detail, to reuse their ids. */
export async function findContributors(files: ContributorFiles, query: string): Promise<ContributorMatch[]> {
  const { publicList, privateRecords } = await loadContributors(files);
  const q = normalize(query);
  const matches = new Map<string, ContributorMatch>();
  for (const c of publicList) {
    if (normalize(c.name).includes(q)) matches.set(c.id, { id: c.id, name: c.name, public: true, matchedContact: false });
  }
  for (const [id, record] of Object.entries(privateRecords)) {
    const byName = record.name !== undefined && normalize(record.name).includes(q);
    const byContact = [record.email, record.contact].some((v) => v !== undefined && normalize(v) === q);
    if (!byName && !byContact) continue;
    const existing = matches.get(id);
    matches.set(id, {
      id,
      name: existing?.name ?? record.name,
      public: existing?.public ?? publicList.some((c) => c.id === id),
      matchedContact: byContact,
    });
  }
  return [...matches.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/**
 * Adds a contributor to the private file with the next free id ("u-001", ...).
 * The display name becomes public only when a restaurant crediting them is
 * promoted (see publishContributors).
 */
export async function addContributor(
  files: ContributorFiles,
  details: { name: string; email?: string; contact?: string },
): Promise<string> {
  const name = details.name.trim();
  if (!name) throw new IntakeError('a display name is required (--name "...")');
  const { publicList, privateRecords } = await loadContributors(files);
  const ids = [...publicList.map((c) => c.id), ...Object.keys(privateRecords)];
  const next = Math.max(0, ...ids.map((id) => Number(id.slice(2)))) + 1;
  const id = `u-${String(next).padStart(3, '0')}`;
  const record = { name, ...(details.email ? { email: details.email } : {}), ...(details.contact ? { contact: details.contact } : {}) };
  const updated = privateContributorsSchema.parse({ ...privateRecords, [id]: record });
  await mkdir(path.dirname(files.privateFile), { recursive: true });
  await writeFile(files.privateFile, `${JSON.stringify(updated, null, 2)}\n`);
  return id;
}

/**
 * Copies the display names of the given ids from the private file into the
 * public list (contact details stay private). Returns the ids that were added.
 */
export async function publishContributors(files: ContributorFiles, ids: string[]): Promise<string[]> {
  const { publicList, privateRecords } = await loadContributors(files);
  const added: string[] = [];
  for (const id of ids) {
    if (publicList.some((c) => c.id === id)) continue;
    const name = privateRecords[id]?.name;
    if (!name) throw new IntakeError(`contributor "${id}" has no display name in ${files.privateFile}`);
    publicList.push({ id, name });
    added.push(id);
  }
  if (added.length > 0) {
    publicList.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    const checked = publicContributorsSchema.parse(publicList);
    await mkdir(path.dirname(files.publicFile), { recursive: true });
    await writeFile(files.publicFile, `${JSON.stringify(checked, null, 2)}\n`);
  }
  return added;
}
