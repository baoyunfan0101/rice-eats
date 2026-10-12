// Intake of Tally form submissions (docs/submissions.md). Reads a Tally CSV
// export or a submission transcribed from a notification email, stores it as
// raw material in the private submissions folder, downloads its photos with
// bounded checks, and reports how it relates to the database. It never
// creates drafts or touches content/: that stays with the restaurant-intake
// Skill and the maintainer.
//
// Everything in a submission (text, names, ids, links) is untrusted input.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  HIDDEN_FIELDS,
  TALLY_CONSENT_OPTION,
  TALLY_MAX_PHOTO_BYTES,
  TALLY_MAX_PHOTOS,
  TALLY_QUESTIONS,
  ratingFromAnswer,
} from '../../shared/submission.ts';
import type { Rating } from '../../shared/content/vocabulary.ts';
import { IntakeError } from './intake.ts';
import { INFO_FILE } from './pipeline.ts';
import { sniffImageFormat } from './privacy.ts';

/** A submission as stored in private/submissions/tally-<id>/submission.json. */
export const submissionSchema = z
  .object({
    submissionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, "-" and "_" only'),
    submittedAt: z.string().optional(),
    source: z.string().optional(),
    /** From the hidden field: a claim to verify, not an instruction. */
    restaurantId: z.string().optional(),
    restaurantName: z.string().optional(),
    review: z.string().optional(),
    /** The answer as submitted; the stored rating is derived with ratingFromAnswer. */
    ratingAnswer: z.string().optional(),
    photoUrls: z.array(z.string()).default([]),
    displayName: z.string().optional(),
    /** Private: never copied into content/ or the website. */
    email: z.string().optional(),
    consent: z.boolean(),
  })
  .strict();
export type Submission = z.infer<typeof submissionSchema>;

// ---------------------------------------------------------------------------
// Reading submissions

/** Minimal RFC 4180 CSV parser (quoted fields, embedded commas and newlines, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim() !== ''));
}

const normalizeHeader = (text: string) => text.normalize('NFKC').trim().toLowerCase();

const YES = new Set(['true', 'yes', 'checked']);

/** Turns the rows of a Tally CSV export into submissions; reports missing columns. */
export function submissionsFromCsv(text: string): Submission[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new IntakeError('the CSV file is empty');
  const headers = header.map(normalizeHeader);
  const columns = (names: readonly string[]) =>
    headers.flatMap((h, i) => (names.some((name) => h.startsWith(normalizeHeader(name))) ? [i] : []));
  const exact = (name: string) => headers.indexOf(normalizeHeader(name));

  const idColumn = exact('Submission ID');
  if (idColumn < 0) {
    throw new IntakeError('no "Submission ID" column; export the responses from Tally as CSV');
  }
  const consentColumns = columns(TALLY_QUESTIONS.consent);
  if (consentColumns.length === 0) {
    throw new IntakeError(
      `no consent column (a header starting with "${TALLY_QUESTIONS.consent[0]}"); ` +
        'check the form against docs/submissions.md',
    );
  }
  const first = (names: readonly string[]) => columns(names)[0];
  const picked = {
    restaurantName: first(TALLY_QUESTIONS.restaurantName),
    review: first(TALLY_QUESTIONS.review),
    photos: columns(TALLY_QUESTIONS.photos),
    rating: first(TALLY_QUESTIONS.rating),
    displayName: first(TALLY_QUESTIONS.displayName),
    email: first(TALLY_QUESTIONS.email),
    restaurantId: exact(HIDDEN_FIELDS.restaurantId),
    hiddenName: exact(HIDDEN_FIELDS.restaurantName),
    source: exact(HIDDEN_FIELDS.source),
    submittedAt: exact('Submitted at'),
  };

  return rows.map((row, i) => {
    const value = (column: number | undefined) =>
      column === undefined || column < 0 ? undefined : row[column]?.trim() || undefined;
    const submissionId = value(idColumn);
    if (!submissionId) throw new IntakeError(`row ${i + 2}: no submission id`);
    // The consent question has one option; an export shows it as the option
    // text or as true/false. Anything other than a clear yes counts as no consent.
    const agreed = normalizeHeader(TALLY_CONSENT_OPTION);
    const consent = consentColumns.some((c) => {
      const v = normalizeHeader(row[c] ?? '');
      return YES.has(v) || v.startsWith(agreed) || v.startsWith('i agree');
    });
    const urls = picked.photos.flatMap((c) => (row[c] ?? '').match(/https?:\/\/[^\s,]+/g) ?? []);
    return submissionSchema.parse({
      submissionId,
      submittedAt: value(picked.submittedAt),
      source: value(picked.source),
      restaurantId: value(picked.restaurantId),
      restaurantName: value(picked.restaurantName) ?? value(picked.hiddenName),
      review: value(picked.review),
      ratingAnswer: value(picked.rating),
      photoUrls: [...new Set(urls)],
      displayName: value(picked.displayName),
      email: value(picked.email),
      consent,
    });
  });
}

/** Reads a .csv export (one or more submissions) or a .json submission (one or a list). */
export async function readSubmissions(file: string): Promise<Submission[]> {
  if (!existsSync(file)) throw new IntakeError(`${file} does not exist`);
  const text = await readFile(file, 'utf8');
  if (file.toLowerCase().endsWith('.csv')) return submissionsFromCsv(text);
  if (file.toLowerCase().endsWith('.json')) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new IntakeError(`${file}: invalid JSON (${(e as Error).message})`);
    }
    const parsed = z.array(submissionSchema).safeParse(Array.isArray(data) ? data : [data]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new IntakeError(`${file}: ${issue.path.join('.') || 'submission'}: ${issue.message}`);
    }
    return parsed.data;
  }
  throw new IntakeError(`${file}: expected a Tally .csv export or a .json submission`);
}

// ---------------------------------------------------------------------------
// Restaurant identity

export interface KnownRestaurant {
  id: string;
  name: string;
  altNames: string[];
  address?: string;
  where: 'content' | 'draft';
}

export async function loadKnownRestaurants(
  restaurantsDir: string,
  draftsDir?: string,
): Promise<KnownRestaurant[]> {
  const known: KnownRestaurant[] = [];
  for (const [dir, where] of [
    [restaurantsDir, 'content'],
    [draftsDir, 'draft'],
  ] as const) {
    if (!dir || !existsSync(dir)) continue;
    for (const folder of await readdir(dir)) {
      const file = path.join(dir, folder, INFO_FILE);
      if (!existsSync(file)) continue;
      try {
        const info = JSON.parse(await readFile(file, 'utf8')) as Partial<KnownRestaurant>;
        if (typeof info.id !== 'string' || typeof info.name !== 'string') continue;
        known.push({
          id: info.id,
          name: info.name,
          altNames: Array.isArray(info.altNames) ? info.altNames : [],
          ...(typeof info.address === 'string' ? { address: info.address } : {}),
          where,
        });
      } catch {
        // Invalid records are reported by content:check.
      }
    }
  }
  return known;
}

const normalizeName = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

const nameMatches = (restaurant: KnownRestaurant, name: string) =>
  [restaurant.name, ...restaurant.altNames].some((n) => normalizeName(n) === normalizeName(name));

export type Identity =
  /** The id exists and the submitted name (if any) is one of its names. */
  | { kind: 'existing'; restaurant: KnownRestaurant }
  /** The id exists but the submitted name belongs to another restaurant or none. */
  | { kind: 'conflict'; restaurant: KnownRestaurant; submittedName: string; candidates: KnownRestaurant[] }
  /** The id does not exist (stale link or tampered URL); name candidates follow. */
  | { kind: 'unknown-id'; id: string; candidates: KnownRestaurant[] }
  /** No id; the name matches existing restaurants (could be the same place or a namesake). */
  | { kind: 'candidates'; candidates: KnownRestaurant[] }
  /** No id and no matching name: probably a restaurant that is not listed yet. */
  | { kind: 'new' }
  /** Neither an id nor a name was submitted. */
  | { kind: 'unidentified' };

/**
 * Resolves which restaurant a submission is about. The result is a proposal
 * for the maintainer; a hidden-field id is never trusted on its own.
 */
export function resolveIdentity(submission: Submission, known: KnownRestaurant[]): Identity {
  const name = submission.restaurantName?.trim();
  const byName = name ? known.filter((r) => nameMatches(r, name)) : [];
  const id = submission.restaurantId?.trim();
  if (id) {
    const restaurant = known.find((r) => r.id === id);
    if (!restaurant) return { kind: 'unknown-id', id, candidates: byName };
    if (name && !nameMatches(restaurant, name)) {
      return { kind: 'conflict', restaurant, submittedName: name, candidates: byName };
    }
    return { kind: 'existing', restaurant };
  }
  if (!name) return { kind: 'unidentified' };
  return byName.length > 0 ? { kind: 'candidates', candidates: byName } : { kind: 'new' };
}

// ---------------------------------------------------------------------------
// Photos

/** Tally serves uploads from tally.so hosts; other links in a submission are not fetched. */
export function isAllowedPhotoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'tally.so' || parsed.hostname.endsWith('.tally.so'))
    );
  } catch {
    return false;
  }
}

/** Removes query strings and fragments (signed-URL tokens) before a link is printed. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(invalid link)';
  }
}

const EXTENSIONS: Record<string, string> = { jpeg: '.jpg', png: '.png', webp: '.webp', heif: '.heic' };

export interface PhotoResult {
  url: string;
  file?: string;
  problem?: string;
}

/**
 * Downloads submitted photos into `dir` as photo-01.<ext>, ... Only https
 * links on tally.so hosts are fetched, at most TALLY_MAX_PHOTOS of them, each
 * at most TALLY_MAX_PHOTO_BYTES, with a timeout. A download is kept only if
 * its content is a supported image; names come from the content type, never
 * from the submitted file name.
 */
export async function downloadPhotos(
  urls: string[],
  dir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PhotoResult[]> {
  const results: PhotoResult[] = [];
  let number = 0;
  for (const [i, url] of urls.entries()) {
    const shown = redactUrl(url);
    if (i >= TALLY_MAX_PHOTOS) {
      results.push({ url: shown, problem: `more than ${TALLY_MAX_PHOTOS} photos; not downloaded` });
      continue;
    }
    if (!isAllowedPhotoUrl(url)) {
      results.push({ url: shown, problem: 'not an https link on tally.so; not downloaded' });
      continue;
    }
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status} (the link may have expired)`);
      if (response.url && !response.url.startsWith('https:')) throw new Error('redirected to a non-https link');
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > TALLY_MAX_PHOTO_BYTES) throw new Error('larger than 10 MB');
      const bytes = await readLimited(response, TALLY_MAX_PHOTO_BYTES);
      await mkdir(dir, { recursive: true });
      const temp = path.join(dir, `.download-${i}`);
      await writeFile(temp, bytes);
      const format = await sniffImageFormat(temp);
      const ext = format ? EXTENSIONS[format] : undefined;
      if (!ext) {
        await rm(temp);
        throw new Error('not a JPEG, PNG, WebP, or HEIC image');
      }
      number++;
      const file = path.join(dir, `photo-${String(number).padStart(2, '0')}${ext}`);
      await rm(file, { force: true });
      await writeFile(file, bytes);
      await rm(temp);
      results.push({ url: shown, file });
    } catch (e) {
      results.push({ url: shown, problem: (e as Error).message });
    }
  }
  return results;
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) throw new Error('larger than 10 MB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Processing log and import

export const LOG_FILE = 'tally-log.json';
export const LOG_STATUSES = ['imported', 'drafted', 'processed', 'rejected'] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

const logSchema = z.record(
  z.string(),
  z
    .object({
      status: z.enum(LOG_STATUSES),
      importedAt: z.string(),
      updatedAt: z.string().optional(),
      restaurantId: z.string().optional(),
    })
    .strict(),
);
export type SubmissionLog = z.infer<typeof logSchema>;

/**
 * The private processing log (private/submissions/tally-log.json) records
 * every imported submission id, so a submission is not processed twice even
 * after its raw files are deleted.
 */
export async function readLog(submissionsDir: string): Promise<SubmissionLog> {
  const file = path.join(submissionsDir, LOG_FILE);
  if (!existsSync(file)) return {};
  return logSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

async function writeLog(submissionsDir: string, log: SubmissionLog) {
  await mkdir(submissionsDir, { recursive: true });
  await writeFile(path.join(submissionsDir, LOG_FILE), `${JSON.stringify(log, null, 2)}\n`);
}

export async function markSubmission(
  submissionsDir: string,
  submissionId: string,
  status: LogStatus,
  restaurantId?: string,
) {
  const log = await readLog(submissionsDir);
  const entry = log[submissionId];
  if (!entry) throw new IntakeError(`submission "${submissionId}" has not been imported`);
  log[submissionId] = {
    ...entry,
    status,
    updatedAt: new Date().toISOString(),
    ...(restaurantId ? { restaurantId } : {}),
  };
  await writeLog(submissionsDir, log);
}

export interface ImportResult {
  submission: Submission;
  /** Set when the submission was imported before; nothing was written. */
  duplicate?: SubmissionLog[string];
  dir?: string;
  rating?: Rating;
  identity: Identity;
  photos: PhotoResult[];
  /** Problems that block preparing a draft (e.g. no consent, nothing submitted). */
  blockers: string[];
  /** Things the maintainer should know or decide. */
  notes: string[];
}

export interface ImportOptions {
  submissionsDir: string;
  restaurantsDir: string;
  draftsDir?: string;
  download?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Imports submissions into private/submissions/tally-<id>/ and the log. Does
 * not create drafts, contributors, or anything public.
 */
export async function importSubmissions(
  submissions: Submission[],
  options: ImportOptions,
): Promise<ImportResult[]> {
  const known = await loadKnownRestaurants(options.restaurantsDir, options.draftsDir);
  const log = await readLog(options.submissionsDir);
  const results: ImportResult[] = [];
  for (const submission of submissions) {
    const identity = resolveIdentity(submission, known);
    const rating = ratingFromAnswer(submission.ratingAnswer);
    const blockers: string[] = [];
    const notes: string[] = [];
    const hasText = Boolean(submission.review?.trim());
    const hasPhotos = submission.photoUrls.length > 0;
    if (!submission.consent) {
      blockers.push('no publication consent: do not prepare or publish anything; ask the contributor or reject');
    }
    if (!hasText && !hasPhotos) blockers.push('neither review text nor photos were submitted');
    if (submission.ratingAnswer && rating === undefined) {
      notes.push(`rating answer "${submission.ratingAnswer}" is not one of the five levels; leave the rating out`);
    }
    if (!submission.email) notes.push('no contact email: questions cannot be sent back to the contributor');
    if (!submission.displayName) notes.push('no display name: ask the maintainer how to credit it (e.g. anonymous)');

    const duplicate = log[submission.submissionId];
    if (duplicate) {
      results.push({ submission, duplicate, identity, rating, photos: [], blockers, notes });
      continue;
    }
    const dir = path.join(options.submissionsDir, `tally-${submission.submissionId}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'submission.json'), `${JSON.stringify(submission, null, 2)}\n`);
    const photos =
      options.download === false
        ? submission.photoUrls.map((url) => ({ url: redactUrl(url), problem: 'download skipped' }))
        : await downloadPhotos(submission.photoUrls, dir, options.fetchImpl);
    if (photos.some((p) => p.problem)) {
      notes.push('some photos were not downloaded; download them from the Tally submission or ask for copies');
    }
    log[submission.submissionId] = { status: 'imported', importedAt: new Date().toISOString() };
    await writeLog(options.submissionsDir, log);
    results.push({ submission, dir, identity, rating, photos, blockers, notes });
  }
  return results;
}

/** Plain-text report for the maintainer. Contact details are never printed. */
export function formatImport(result: ImportResult, rel: (file: string) => string): string {
  const s = result.submission;
  const lines = [`Submission ${s.submissionId}${s.submittedAt ? ` (${s.submittedAt})` : ''}`];
  if (result.duplicate) {
    lines.push(
      `  duplicate: already imported ${result.duplicate.importedAt} (status ${result.duplicate.status}` +
        `${result.duplicate.restaurantId ? `, restaurant ${result.duplicate.restaurantId}` : ''}); nothing written`,
    );
    return lines.join('\n');
  }
  lines.push(`  saved:      ${rel(result.dir!)}/ (private)`);
  lines.push(`  source:     ${s.source ?? '(unknown)'}`);
  lines.push(`  restaurant: ${describeIdentity(result.identity, s)}`);
  const kind = [s.review?.trim() && 'review text', s.photoUrls.length && `${s.photoUrls.length} photo(s)`]
    .filter(Boolean)
    .join(' + ');
  lines.push(`  content:    ${kind || 'nothing'}`);
  lines.push(`  rating:     ${result.rating ?? 'none'}`);
  lines.push(
    `  credit:     ${s.displayName ? `display name "${s.displayName}"` : 'no display name'}; ` +
      `${s.email ? 'contact email provided (private)' : 'no contact email'}`,
  );
  lines.push(`  consent:    ${s.consent ? 'yes' : 'NO'}`);
  for (const photo of result.photos) {
    lines.push(photo.file ? `  photo       ${rel(photo.file)}` : `  photo       ${photo.url}: ${photo.problem}`);
  }
  for (const blocker of result.blockers) lines.push(`  BLOCKED     ${blocker}`);
  for (const note of result.notes) lines.push(`  note        ${note}`);
  return lines.join('\n');
}

function describeIdentity(identity: Identity, s: Submission): string {
  const label = (r: KnownRestaurant) =>
    `${r.id} "${r.name}"${r.address ? ` (${r.address})` : ''}${r.where === 'draft' ? ' [private draft]' : ''}`;
  const others = (list: KnownRestaurant[]) =>
    list.length ? `; name matches ${list.map(label).join(', ')}` : '';
  switch (identity.kind) {
    case 'existing':
      return `existing ${label(identity.restaurant)}; update it with content:edit only as the maintainer decides`;
    case 'conflict':
      return (
        `CONFLICT: id ${identity.restaurant.id} is "${identity.restaurant.name}" but the submission names ` +
        `"${identity.submittedName}"${others(identity.candidates)}; ask the maintainer`
      );
    case 'unknown-id':
      return `UNKNOWN id "${identity.id}" (not in the database)${others(identity.candidates)}; ask the maintainer`;
    case 'candidates':
      return `"${s.restaurantName}" without an id${others(identity.candidates)}; compare addresses before deciding`;
    case 'new':
      return `"${s.restaurantName}": not in the database; a new draft may be needed`;
    case 'unidentified':
      return 'no restaurant id or name; ask the contributor or the maintainer';
  }
}
