// Intake of Tally form submissions (docs/submissions.md). Reads a Tally CSV
// export or a submission transcribed from a notification email, stores it as
// raw material in the private submissions folder, downloads its photos with
// bounded, validated requests (safe-fetch.ts), tracks which photos are still
// missing so they can be retried or added by hand, and reports how the
// submission relates to the database. It never
// creates drafts or touches content/: that stays with the restaurant-intake
// Skill and the maintainer.
//
// Everything in a submission (text, names, ids, links) is untrusted input.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
import { DownloadError, safeDownload, type Lookup } from './safe-fetch.ts';

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
//
// Each submitted photo link has a fixed slot (its position in the
// submission, 1-based) and is stored as photo-<NN>.<ext>, so retries never
// duplicate files. Its state is kept in photos.json next to submission.json:
//
//   pending     not attempted yet (or skipped with --skip-photos)
//   failed      the last attempt failed; retry or add the photo by hand
//   downloaded  fetched and verified
//   recovered   added by hand (content:submission -- add-photo) and verified
//   waived      the maintainer decided to proceed without it
//   excluded    beyond the form's 10-photo limit; never fetched
//
// Stored files are re-verified (present, an image, same SHA-256) whenever the
// state is read, so a deleted or corrupted file goes back to "failed".

export const PHOTO_STATE_FILE = 'photos.json';
export const SUBMISSION_FILE = 'submission.json';
export const PHOTO_STATUSES = ['pending', 'failed', 'downloaded', 'recovered', 'waived', 'excluded'] as const;
export type PhotoStatus = (typeof PHOTO_STATUSES)[number];
const USABLE: readonly PhotoStatus[] = ['downloaded', 'recovered'];
const UNRESOLVED: readonly PhotoStatus[] = ['pending', 'failed'];

const photoStateSchema = z.array(
  z
    .object({
      slot: z.number().int().min(1),
      status: z.enum(PHOTO_STATUSES),
      file: z
        .string()
        .regex(/^photo-\d{2}\.(jpg|png|webp|heic)$/)
        .optional(),
      sha256: z.string().optional(),
      /** Last failure, without link tokens. */
      error: z.string().optional(),
      attempts: z.number().int().min(0),
      updatedAt: z.string().optional(),
    })
    .strict(),
);
export type PhotoState = z.infer<typeof photoStateSchema>[number];

const EXTENSIONS: Record<string, string> = { jpeg: '.jpg', png: '.png', webp: '.webp', heif: '.heic' };
const slotStem = (slot: number) => `photo-${String(slot).padStart(2, '0')}`;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();

/** Format and hash of an acceptable photo file, or the reason it is not acceptable. */
async function inspectPhoto(file: string): Promise<{ ext: string; hash: string; bytes: Buffer } | string> {
  if (!existsSync(file)) return 'file is missing';
  const info = await stat(file);
  if (!info.isFile()) return 'not a file';
  if (info.size > TALLY_MAX_PHOTO_BYTES) return 'larger than 10 MB';
  const format = await sniffImageFormat(file);
  const ext = format ? EXTENSIONS[format] : undefined;
  if (!ext) return 'not a JPEG, PNG, WebP, or HEIC image';
  const bytes = await readFile(file);
  return { ext, hash: sha256(bytes), bytes };
}

async function writePhotoState(dir: string, state: PhotoState[]) {
  const file = path.join(dir, PHOTO_STATE_FILE);
  await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * Reads (or creates) photos.json for a stored submission and re-verifies
 * every stored file. Files left by an interrupted run (renamed into place
 * before the state was saved) are adopted after verification.
 */
export async function loadPhotoState(dir: string, submission: Submission): Promise<PhotoState[]> {
  const file = path.join(dir, PHOTO_STATE_FILE);
  let state: PhotoState[];
  if (existsSync(file)) {
    state = photoStateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } else {
    state = submission.photoUrls.map((_, i) => ({
      slot: i + 1,
      status: i < TALLY_MAX_PHOTOS ? 'pending' : 'excluded',
      ...(i < TALLY_MAX_PHOTOS ? {} : { error: `more than ${TALLY_MAX_PHOTOS} photos` }),
      attempts: 0,
    }));
  }
  const names = existsSync(dir) ? await readdir(dir) : [];
  for (const photo of state) {
    if (USABLE.includes(photo.status)) {
      const result = photo.file ? await inspectPhoto(path.join(dir, photo.file)) : 'file is missing';
      if (typeof result === 'string' || result.hash !== photo.sha256) {
        const reason = typeof result === 'string' ? result : 'file has changed';
        // An invalid file is moved aside (never silently overwritten) so the
        // slot can be filled again.
        let aside = '';
        if (photo.file && existsSync(path.join(dir, photo.file))) {
          aside = `.invalid-${photo.file}-${Date.now()}`;
          await rename(path.join(dir, photo.file), path.join(dir, aside));
          aside = `, moved to ${aside}`;
        }
        Object.assign(photo, {
          status: 'failed',
          error: `stored photo invalid (${reason}${aside}); retry or add it again`,
          updatedAt: now(),
        });
        delete photo.file;
        delete photo.sha256;
      }
    } else if (UNRESOLVED.includes(photo.status)) {
      const orphan = names.find((n) => n.startsWith(`${slotStem(photo.slot)}.`));
      if (!orphan) continue;
      const result = await inspectPhoto(path.join(dir, orphan));
      if (typeof result === 'string') continue;
      Object.assign(photo, { status: 'downloaded', file: orphan, sha256: result.hash, updatedAt: now() });
      delete photo.error;
    }
  }
  await writePhotoState(dir, state);
  return state;
}

export interface NetworkOptions {
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
}

/**
 * Downloads the photos that are still pending or failed, one slot at a time,
 * saving the state after each. Verified photos are never fetched again.
 */
export async function fetchMissingPhotos(
  dir: string,
  submission: Submission,
  state: PhotoState[],
  network: NetworkOptions = {},
): Promise<PhotoState[]> {
  for (const photo of state) {
    if (!UNRESOLVED.includes(photo.status)) continue;
    const url = submission.photoUrls[photo.slot - 1];
    const temp = path.join(dir, `.download-${slotStem(photo.slot)}`);
    photo.attempts++;
    photo.updatedAt = now();
    try {
      if (!url) throw new DownloadError('no link for this photo');
      const bytes = await safeDownload(url, {
        maxBytes: TALLY_MAX_PHOTO_BYTES,
        fetchImpl: network.fetchImpl,
        lookup: network.lookup,
      });
      await writeFile(temp, bytes);
      const result = await inspectPhoto(temp);
      if (typeof result === 'string') throw new DownloadError(`downloaded file: ${result}`);
      const name = `${slotStem(photo.slot)}${result.ext}`;
      if (existsSync(path.join(dir, name))) {
        throw new DownloadError(`${name} already exists; not overwriting it`);
      }
      await rename(temp, path.join(dir, name));
      Object.assign(photo, { status: 'downloaded', file: name, sha256: result.hash });
      delete photo.error;
    } catch (e) {
      photo.status = 'failed';
      photo.error = e instanceof DownloadError || e instanceof IntakeError ? e.message : 'could not save the photo';
    } finally {
      await rm(temp, { force: true });
      await writePhotoState(dir, state);
    }
  }
  return state;
}

/**
 * Stores a photo the maintainer downloaded by hand (e.g. from the Tally
 * dashboard after the link expired) in the given slot. The file is validated
 * like a download; the original is not changed. Adding the same file again
 * is a no-op; a verified photo is never replaced.
 */
export async function addManualPhoto(
  dir: string,
  submission: Submission,
  slot: number,
  file: string,
): Promise<PhotoState> {
  const state = await loadPhotoState(dir, submission);
  const photo = state.find((p) => p.slot === slot);
  if (!photo) throw new IntakeError(`submission ${submission.submissionId} has no photo ${slot} (it has ${state.length})`);
  const result = await inspectPhoto(path.resolve(file));
  if (typeof result === 'string') throw new IntakeError(`${file}: ${result}`);
  if (USABLE.includes(photo.status)) {
    if (photo.sha256 === result.hash) return photo;
    throw new IntakeError(`photo ${slot} is already stored as ${photo.file}; not replacing it`);
  }
  if (photo.status === 'excluded') throw new IntakeError(`photo ${slot} is beyond the ${TALLY_MAX_PHOTOS}-photo limit`);
  const name = `${slotStem(slot)}${result.ext}`;
  await writeFile(path.join(dir, name), result.bytes, { flag: 'wx' });
  Object.assign(photo, { status: 'recovered', file: name, sha256: result.hash, updatedAt: now() });
  delete photo.error;
  await writePhotoState(dir, state);
  return photo;
}

/** Records the maintainer's decision to proceed without an unresolved photo. */
export async function waivePhoto(dir: string, submission: Submission, slot: number): Promise<PhotoState> {
  const state = await loadPhotoState(dir, submission);
  const photo = state.find((p) => p.slot === slot);
  if (!photo) throw new IntakeError(`submission ${submission.submissionId} has no photo ${slot}`);
  if (!UNRESOLVED.includes(photo.status)) throw new IntakeError(`photo ${slot} is ${photo.status}; nothing to waive`);
  Object.assign(photo, { status: 'waived', updatedAt: now() });
  await writePhotoState(dir, state);
  return photo;
}

export type PhotoSummary = 'none' | 'complete' | 'incomplete';

export function photoSummary(state: PhotoState[]): PhotoSummary {
  if (state.length === 0) return 'none';
  return state.some((p) => UNRESOLVED.includes(p.status)) ? 'incomplete' : 'complete';
}

export interface Readiness {
  /** Problems that block preparing a draft. */
  blockers: string[];
  /** Things the maintainer should know or decide. */
  notes: string[];
  photos: PhotoSummary;
}

/** Whether a stored submission has enough valid material (and consent) for a private draft. */
export function readiness(submission: Submission, state: PhotoState[]): Readiness {
  const blockers: string[] = [];
  const notes: string[] = [];
  const hasText = Boolean(submission.review?.trim());
  const usable = state.filter((p) => USABLE.includes(p.status)).length;
  const unresolved = state.filter((p) => UNRESOLVED.includes(p.status)).map((p) => p.slot);
  if (!submission.consent) {
    blockers.push('no publication consent: do not prepare or publish anything; ask the contributor or reject');
  }
  if (!hasText && submission.photoUrls.length === 0) blockers.push('neither review text nor photos were submitted');
  if (!hasText && submission.photoUrls.length > 0 && usable === 0) {
    blockers.push('photo-only submission without any retrieved photo: retry, add the photos by hand, or reject');
  }
  if (unresolved.length > 0) {
    notes.push(
      `photo intake incomplete (photo ${unresolved.join(', ')} missing): run retry-photos, add them with ` +
        'add-photo, or waive them if the maintainer decides to proceed without them',
    );
  }
  const rating = ratingFromAnswer(submission.ratingAnswer);
  if (submission.ratingAnswer && rating === undefined) {
    notes.push(`rating answer "${submission.ratingAnswer}" is not one of the five levels; leave the rating out`);
  }
  if (!submission.email) notes.push('no contact email: questions cannot be sent back to the contributor');
  if (!submission.displayName) notes.push('no display name: ask the maintainer how to credit it (e.g. anonymous)');
  return { blockers, notes, photos: photoSummary(state) };
}

// ---------------------------------------------------------------------------
// Processing log and import

export const LOG_FILE = 'tally-log.json';
/** Editorial status, separate from photo retrieval (see PhotoSummary). */
export const LOG_STATUSES = ['imported', 'drafted', 'processed', 'rejected'] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

const logSchema = z.record(
  z.string(),
  z
    .object({
      status: z.enum(LOG_STATUSES),
      photos: z.enum(['none', 'complete', 'incomplete']).optional(),
      importedAt: z.string(),
      updatedAt: z.string().optional(),
      restaurantId: z.string().optional(),
    })
    .strict(),
);
export type SubmissionLog = z.infer<typeof logSchema>;
export type LogEntry = SubmissionLog[string];

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

async function updateLog(submissionsDir: string, id: string, change: (entry?: LogEntry) => LogEntry) {
  const log = await readLog(submissionsDir);
  log[id] = change(log[id]);
  await mkdir(submissionsDir, { recursive: true });
  const file = path.join(submissionsDir, LOG_FILE);
  await writeFile(`${file}.tmp`, `${JSON.stringify(log, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
  return log[id]!;
}

export async function markSubmission(
  submissionsDir: string,
  submissionId: string,
  status: LogStatus,
  restaurantId?: string,
) {
  if (!(await readLog(submissionsDir))[submissionId]) {
    throw new IntakeError(`submission "${submissionId}" has not been imported`);
  }
  await updateLog(submissionsDir, submissionId, (entry) => ({
    ...entry!,
    status,
    updatedAt: now(),
    ...(restaurantId ? { restaurantId } : {}),
  }));
}

export const submissionDir = (submissionsDir: string, id: string) => path.join(submissionsDir, `tally-${id}`);

export interface SubmissionReport {
  submission: Submission;
  /**
   * new: imported now; resumed: imported before, photo intake continued;
   * duplicate: imported before with complete photo intake, nothing to do;
   * archived: imported before and its raw files were removed after processing.
   */
  outcome: 'new' | 'resumed' | 'duplicate' | 'archived' | 'status';
  entry?: LogEntry;
  dir?: string;
  rating?: Rating;
  identity: Identity;
  photos: PhotoState[];
  blockers: string[];
  notes: string[];
}

export interface ImportOptions extends NetworkOptions {
  submissionsDir: string;
  restaurantsDir: string;
  draftsDir?: string;
  /** false: record photos as pending without downloading them. */
  download?: boolean;
}

async function readStoredSubmission(dir: string): Promise<Submission> {
  return submissionSchema.parse(JSON.parse(await readFile(path.join(dir, SUBMISSION_FILE), 'utf8')));
}

/**
 * Imports submissions into private/submissions/tally-<id>/ and the log, and
 * downloads their photos. A submission imported before is not imported again:
 * if its photos are incomplete they are retried, otherwise it is skipped.
 * Never creates drafts, contributors, or anything public.
 */
export async function importSubmissions(
  submissions: Submission[],
  options: ImportOptions,
): Promise<SubmissionReport[]> {
  const known = await loadKnownRestaurants(options.restaurantsDir, options.draftsDir);
  const reports: SubmissionReport[] = [];
  for (const incoming of submissions) {
    const id = incoming.submissionId;
    const dir = submissionDir(options.submissionsDir, id);
    const logged = (await readLog(options.submissionsDir))[id];
    const stored = existsSync(path.join(dir, SUBMISSION_FILE));
    if (logged && !stored) {
      reports.push(report(incoming, 'archived', known, [], { entry: logged }));
      continue;
    }
    // The stored record is kept; a differing export is reported, not merged.
    const submission = stored ? await readStoredSubmission(dir) : incoming;
    const extra: string[] = [];
    if (stored && JSON.stringify(submission) !== JSON.stringify(incoming)) {
      extra.push('this export differs from the stored submission; the stored one was kept');
    }
    if (!stored) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, SUBMISSION_FILE), `${JSON.stringify(submission, null, 2)}\n`, { flag: 'wx' });
    }
    let state = await loadPhotoState(dir, submission);
    const entry = await updateLog(options.submissionsDir, id, (e) => e ?? { status: 'imported', importedAt: now() });
    const before = photoSummary(state);
    if (logged && before !== 'incomplete') {
      reports.push(report(submission, 'duplicate', known, state, { entry, dir, extra }));
      continue;
    }
    if (options.download !== false) state = await fetchMissingPhotos(dir, submission, state, options);
    const updated = await updateLog(options.submissionsDir, id, (e) => ({ ...e!, photos: photoSummary(state) }));
    reports.push(report(submission, logged ? 'resumed' : 'new', known, state, { entry: updated, dir, extra }));
  }
  return reports;
}

/** Loads a stored submission for retry-photos, add-photo, waive-photo, and status. */
export async function openSubmission(submissionsDir: string, id: string) {
  const entry = (await readLog(submissionsDir))[id];
  if (!entry) throw new IntakeError(`submission "${id}" has not been imported`);
  const dir = submissionDir(submissionsDir, id);
  if (!existsSync(path.join(dir, SUBMISSION_FILE))) {
    throw new IntakeError(`the raw files of submission "${id}" were removed (status ${entry.status})`);
  }
  return { dir, submission: await readStoredSubmission(dir) };
}

/** Retries the photos of a stored submission that are pending or failed. */
export async function retryPhotos(id: string, options: ImportOptions): Promise<SubmissionReport> {
  const { dir, submission } = await openSubmission(options.submissionsDir, id);
  const state = await fetchMissingPhotos(dir, submission, await loadPhotoState(dir, submission), options);
  return submissionStatus(id, options, state);
}

/** Current state of a stored submission (re-verifies its files; no network). */
export async function submissionStatus(
  id: string,
  options: ImportOptions,
  known?: PhotoState[],
): Promise<SubmissionReport> {
  const { dir, submission } = await openSubmission(options.submissionsDir, id);
  const state = known ?? (await loadPhotoState(dir, submission));
  const entry = await updateLog(options.submissionsDir, id, (e) => ({ ...e!, photos: photoSummary(state) }));
  const restaurants = await loadKnownRestaurants(options.restaurantsDir, options.draftsDir);
  return report(submission, 'status', restaurants, state, { entry, dir });
}

function report(
  submission: Submission,
  outcome: SubmissionReport['outcome'],
  known: KnownRestaurant[],
  photos: PhotoState[],
  more: { entry?: LogEntry; dir?: string; extra?: string[] },
): SubmissionReport {
  const { blockers, notes } = readiness(submission, photos);
  return {
    submission,
    outcome,
    entry: more.entry,
    dir: more.dir,
    rating: ratingFromAnswer(submission.ratingAnswer),
    identity: resolveIdentity(submission, known),
    photos,
    blockers,
    notes: [...(more.extra ?? []), ...notes],
  };
}

/** Plain-text report for the maintainer. Contact details and link tokens are never printed. */
export function formatReport(result: SubmissionReport, rel: (file: string) => string): string {
  const s = result.submission;
  const lines = [`Submission ${s.submissionId}${s.submittedAt ? ` (${s.submittedAt})` : ''}`];
  const entry = result.entry;
  if (result.outcome === 'archived') {
    lines.push(
      `  already imported ${entry!.importedAt} (status ${entry!.status}` +
        `${entry!.restaurantId ? `, restaurant ${entry!.restaurantId}` : ''}); raw files removed, nothing written`,
    );
    return lines.join('\n');
  }
  const status = {
    new: 'imported now',
    resumed: 'imported before; continued the photo intake',
    duplicate: 'already imported, photo intake complete; nothing to do',
    status: 'stored',
  }[result.outcome];
  lines.push(`  intake:     ${status}; editorial status ${entry?.status ?? 'imported'}`);
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
  lines.push(`  photos:     ${photoSummary(result.photos)}`);
  for (const p of result.photos) {
    const detail = p.file ? rel(path.join(result.dir!, p.file)) : (p.error ?? '');
    const tries = p.attempts > 0 ? ` (${p.attempts} attempt${p.attempts > 1 ? 's' : ''})` : '';
    lines.push(`    ${String(p.slot).padStart(2)}  ${p.status.padEnd(10)} ${detail}${tries}`);
  }
  for (const blocker of result.blockers) lines.push(`  BLOCKED     ${blocker}`);
  for (const note of result.notes) lines.push(`  note        ${note}`);
  if (result.blockers.length === 0) {
    lines.push(
      photoSummary(result.photos) === 'incomplete'
        ? '  next:       ask the maintainer whether to wait for the missing photos or proceed without them'
        : '  next:       ready for a private draft (restaurant-intake Skill); nothing is published without approval',
    );
  }
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
