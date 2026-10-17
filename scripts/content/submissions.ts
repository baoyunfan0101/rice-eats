// Intake of Tally form submissions (docs/submissions.md). Reads a Tally CSV
// export or a submission transcribed from a notification email, stores it in
// the private submissions folder (kept for good, whatever its status:
// docs/submissions.md#retention), downloads its photos with
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
  dishQuestion,
  HIDDEN_FIELDS,
  isValidLatLng,
  SELECTION_METHODS,
  type SelectionMethod,
  type LatLngValue,
  parseList,
  TALLY_CONSENT_OPTION,
  TALLY_DISH_GROUPS,
  TALLY_MAX_DISH_PHOTOS,
  TALLY_MAX_GENERAL_PHOTOS,
  TALLY_MAX_PHOTO_BYTES,
  TALLY_QUESTIONS,
  ratingFromAnswer,
  verdictFromAnswer,
} from '../../shared/submission.ts';
import { normalizeKeyword } from '../../shared/content/schema.ts';
import type { Rating } from '../../shared/content/vocabulary.ts';
import { IntakeError } from './intake.ts';
import { reviewHints, type ReviewText } from './moderation.ts';
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
    /** The selected or manually entered restaurant name (hidden field). */
    restaurantName: z.string().optional(),
    /** Other names of the restaurant the contributor gave (the form's alias question). */
    restaurantAltNames: z.array(z.string()).default([]),
    restaurantAddress: z.string().optional(),
    /** The explicitly selected restaurant location, only when the coordinates are valid. */
    restaurantLocation: z.object({ lat: z.number(), lng: z.number() }).strict().optional(),
    /** Coordinates as submitted when they were not valid. */
    restaurantLocationRaw: z.string().optional(),
    /** External POI that was selected (private; never a Rice Eats id). */
    poi: z.object({ provider: z.string(), id: z.string() }).strict().optional(),
    /** existing, poi, or manual (anything else is reported). */
    selectionMethod: z.string().optional(),
    review: z.string().optional(),
    /** The answer as submitted; the stored rating is derived with ratingFromAnswer. */
    ratingAnswer: z.string().optional(),
    /** General photos (not tied to a dish). */
    photoUrls: z.array(z.string()).default([]),
    /** Dish groups in form order; each dish's photos show that dish. */
    dishes: z
      .array(
        z
          .object({
            name: z.string().optional(),
            /** The answer as submitted; mapped with verdictFromAnswer. */
            verdictAnswer: z.string().optional(),
            comment: z.string().optional(),
            photoUrls: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .default([]),
    /**
     * The contributor's own keywords (the form's keyword question, split by
     * parseList), as typed. Mapped to tags by prepare.ts.
     */
    keywords: z.array(z.string()).default([]),
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
    review: first(TALLY_QUESTIONS.review),
    photos: columns(TALLY_QUESTIONS.photos),
    rating: first(TALLY_QUESTIONS.rating),
    displayName: first(TALLY_QUESTIONS.displayName),
    email: first(TALLY_QUESTIONS.email),
    restaurantId: exact(HIDDEN_FIELDS.restaurantId),
    restaurantName: exact(HIDDEN_FIELDS.restaurantName),
    lat: exact(HIDDEN_FIELDS.lat),
    lng: exact(HIDDEN_FIELDS.lng),
    address: exact(HIDDEN_FIELDS.address),
    poiProvider: exact(HIDDEN_FIELDS.poiProvider),
    poiId: exact(HIDDEN_FIELDS.poiId),
    selectionMethod: exact(HIDDEN_FIELDS.selectionMethod),
    source: exact(HIDDEN_FIELDS.source),
    keywords: first(TALLY_QUESTIONS.keywords),
    altNames: first(TALLY_QUESTIONS.altNames),
    submittedAt: exact('Submitted at'),
  };

  const dishColumns = Array.from({ length: TALLY_DISH_GROUPS }, (_, g) => ({
    name: first([dishQuestion(g + 1, 'name')]),
    verdict: first([dishQuestion(g + 1, 'verdict')]),
    comment: first([dishQuestion(g + 1, 'comment')]),
    photos: columns([dishQuestion(g + 1, 'photos')]),
  }));

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
    const linksIn = (cols: number[]) => [
      ...new Set(cols.flatMap((c) => (row[c] ?? '').match(/https?:\/\/[^\s,]+/g) ?? [])),
    ];
    const dishes = dishColumns
      .map((d) => ({
        name: value(d.name),
        verdictAnswer: value(d.verdict),
        comment: value(d.comment),
        photoUrls: linksIn(d.photos),
      }))
      .filter((d) => d.name || d.verdictAnswer || d.comment || d.photoUrls.length > 0);
    return submissionSchema.parse({
      submissionId,
      submittedAt: value(picked.submittedAt),
      source: value(picked.source),
      restaurantId: value(picked.restaurantId),
      restaurantName: value(picked.restaurantName),
      restaurantAltNames: parseList(value(picked.altNames)),
      restaurantAddress: value(picked.address),
      ...parseLocation(value(picked.lat), value(picked.lng)),
      ...(value(picked.poiProvider) && value(picked.poiId)
        ? { poi: { provider: value(picked.poiProvider)!, id: value(picked.poiId)! } }
        : {}),
      selectionMethod: value(picked.selectionMethod),
      review: value(picked.review),
      ratingAnswer: value(picked.rating),
      photoUrls: linksIn(picked.photos),
      dishes,
      keywords: parseList(value(picked.keywords)),
      displayName: value(picked.displayName),
      email: value(picked.email),
      consent,
    });
  });
}

/** Parses hidden-field coordinates; invalid ones are kept only as text for the report. */
export function parseLocation(
  lat: string | undefined,
  lng: string | undefined,
): Pick<Submission, 'restaurantLocation' | 'restaurantLocationRaw'> {
  if (lat === undefined && lng === undefined) return {};
  const number = (v: string | undefined) => (v !== undefined && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);
  const location = { lat: number(lat), lng: number(lng) };
  return isValidLatLng(location)
    ? { restaurantLocation: location }
    : { restaurantLocationRaw: `${lat ?? ''},${lng ?? ''}` };
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
  /** name and altNames, for matching. */
  names: string[];
  address?: string;
  location?: LatLngValue;
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
        const info = JSON.parse(await readFile(file, 'utf8')) as {
          id?: unknown;
          name?: unknown;
          altNames?: unknown;
          address?: unknown;
          location?: Partial<LatLngValue>;
        };
        if (typeof info.id !== 'string' || typeof info.name !== 'string' || !info.name.trim()) continue;
        const alt = Array.isArray(info.altNames) ? info.altNames : [];
        known.push({
          id: info.id,
          name: info.name,
          names: [info.name, ...alt].filter((n): n is string => typeof n === 'string' && n.trim() !== ''),
          ...(typeof info.address === 'string' ? { address: info.address } : {}),
          ...(isValidLatLng(info.location) ? { location: { lat: info.location.lat, lng: info.location.lng } } : {}),
          where,
        });
      } catch {
        // Invalid records are reported by content:check.
      }
    }
  }
  return known;
}

const nameMatches = (restaurant: KnownRestaurant, name: string | undefined) =>
  !!name?.trim() && restaurant.names.some((n) => normalizeKeyword(n) === normalizeKeyword(name));

/** Great-circle distance in meters. */
export function distanceMeters(a: LatLngValue, b: LatLngValue): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Two places closer than this may be the same restaurant (POI coordinates differ a little). */
export const NEARBY_METERS = 150;

export interface Candidate {
  restaurant: KnownRestaurant;
  /** Meters between the submitted location and the restaurant, when both are known. */
  distance?: number;
  nameMatch: boolean;
}

export type Identity =
  /** The id exists and nothing in the submission contradicts it. */
  | { kind: 'existing'; restaurant: KnownRestaurant }
  /** The id exists but the submitted name and location point elsewhere. */
  | { kind: 'conflict'; restaurant: KnownRestaurant; reason: string; candidates: Candidate[] }
  /** The id does not exist (stale link or tampered URL). */
  | { kind: 'unknown-id'; id: string; candidates: Candidate[] }
  /** The same POI was linked to this restaurant by an earlier, reviewed submission. */
  | { kind: 'poi-match'; restaurant: KnownRestaurant; poi: string }
  /** Existing restaurants that may be the same place; a maintainer decides. */
  | { kind: 'candidates'; candidates: Candidate[] }
  /** Nothing similar nearby or by name: probably a restaurant that is not listed yet. */
  | { kind: 'new' }
  /** Neither an id nor a name was submitted. */
  | { kind: 'unidentified' };

/** POI key used in the private log, e.g. "geoapify:51a3…". */
export const poiKey = (poi: { provider: string; id: string }) => `${poi.provider}:${poi.id}`;

/**
 * Resolves which restaurant a submission is about, in this order: the Rice
 * Eats id from a restaurant page, a POI already linked to a restaurant by an
 * earlier reviewed submission, then location and names. The result is always
 * a proposal for the maintainer: hidden fields are never trusted on their own,
 * names alone never merge restaurants, and branches of a chain (same name,
 * different place) stay separate candidates.
 */
export function resolveIdentity(
  submission: Submission,
  known: KnownRestaurant[],
  poiIndex: Map<string, string> = new Map(),
): Identity {
  const name = submission.restaurantName?.trim();
  const location = submission.restaurantLocation;
  const candidates: Candidate[] = known
    .map((restaurant) => ({
      restaurant,
      distance:
        location && restaurant.location ? distanceMeters(location, restaurant.location) : undefined,
      nameMatch: nameMatches(restaurant, name),
    }))
    .filter((c) => c.nameMatch || (c.distance !== undefined && c.distance <= NEARBY_METERS))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

  const id = submission.restaurantId?.trim();
  if (id) {
    const restaurant = known.find((r) => r.id === id);
    if (!restaurant) return { kind: 'unknown-id', id, candidates };
    const far =
      location && restaurant.location
        ? distanceMeters(location, restaurant.location) > NEARBY_METERS * 2
        : false;
    // A different name is a conflict even close by: neighbors are other restaurants.
    if (name && !nameMatches(restaurant, name)) {
      return {
        kind: 'conflict',
        restaurant,
        reason: `the submission names "${name}"${far ? ' at a different location' : ''}`,
        candidates: candidates.filter((c) => c.restaurant.id !== id),
      };
    }
    if (far) {
      return { kind: 'conflict', restaurant, reason: 'the submitted location is elsewhere', candidates };
    }
    return { kind: 'existing', restaurant };
  }

  if (submission.poi) {
    const linked = poiIndex.get(poiKey(submission.poi));
    const restaurant = linked ? known.find((r) => r.id === linked) : undefined;
    if (restaurant) return { kind: 'poi-match', restaurant, poi: poiKey(submission.poi) };
  }
  if (!name && !location) return { kind: 'unidentified' };
  return candidates.length > 0 ? { kind: 'candidates', candidates } : { kind: 'new' };
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
      /** Dish group (1-based) the photo belongs to; absent for general photos. */
      dish: z.number().int().min(1).optional(),
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

export interface PhotoLink {
  url: string;
  dish?: number;
  /** Why the link is never fetched (beyond the form's limits). */
  excluded?: string;
}

/**
 * Every photo link of a submission in slot order: the general photos, then
 * each dish group's photos. Limits mirror the form (10 general, 3 per dish).
 */
export function photoLinks(submission: Submission): PhotoLink[] {
  const limited = (urls: string[], max: number, dish?: number) =>
    urls.map((url, i) => ({
      url,
      ...(dish ? { dish } : {}),
      ...(i >= max ? { excluded: `more than ${max} photos${dish ? ` for dish ${dish}` : ''}` } : {}),
    }));
  return [
    ...limited(submission.photoUrls, TALLY_MAX_GENERAL_PHOTOS),
    ...submission.dishes.flatMap((d, i) => limited(d.photoUrls, TALLY_MAX_DISH_PHOTOS, i + 1)),
  ];
}

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
    state = photoLinks(submission).map((link, i) => ({
      slot: i + 1,
      ...(link.dish ? { dish: link.dish } : {}),
      status: link.excluded ? 'excluded' : 'pending',
      ...(link.excluded ? { error: link.excluded } : {}),
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
    const url = photoLinks(submission)[photo.slot - 1]?.url;
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
  if (photo.status === 'excluded') throw new IntakeError(`photo ${slot} is beyond the form's photo limit`);
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
  const hasText =
    Boolean(submission.review?.trim()) ||
    submission.dishes.some((d) => d.name?.trim() || d.comment?.trim());
  // A valid overall rating is content on its own: the form requires the
  // rating and makes the review text optional, so a rating-only submission
  // is complete (older form versions required the text instead).
  const rating = ratingFromAnswer(submission.ratingAnswer);
  const hasRating = rating !== undefined;
  const links = photoLinks(submission).length;
  const usable = state.filter((p) => USABLE.includes(p.status)).length;
  const unresolved = state.filter((p) => UNRESOLVED.includes(p.status)).map((p) => p.slot);
  if (!submission.consent) {
    blockers.push('no publication consent: do not prepare or publish anything; ask the contributor or reject');
  }
  if (!submission.restaurantName?.trim() && !submission.restaurantId) {
    notes.push('no restaurant name: ask the contributor which restaurant this is');
  }
  const method = submission.selectionMethod;
  if (method && !SELECTION_METHODS.includes(method as SelectionMethod)) {
    notes.push(`unknown selection method "${method}": treat the restaurant fields as unverified`);
  }
  if (submission.restaurantLocationRaw) {
    notes.push(
      `invalid restaurant coordinates "${submission.restaurantLocationRaw}" were ignored: verify the location`,
    );
  }
  if (!submission.restaurantId && submission.restaurantName?.trim() && !submission.restaurantLocation) {
    notes.push('name only, no location: verify where the restaurant is before drafting it');
  } else if (method === 'manual') {
    notes.push('added by hand (not from a map listing): verify the name and location');
  }
  for (const [i, dish] of submission.dishes.entries()) {
    if (!dish.name?.trim()) {
      notes.push(`dish ${i + 1} has no name: its verdict, comment, and photos cannot be attached to a dish`);
    }
    if (!dish.verdictAnswer?.trim()) {
      notes.push(`dish ${i + 1} has no verdict (the form requires one): leave the verdict out`);
    } else if (verdictFromAnswer(dish.verdictAnswer) === undefined) {
      notes.push(`dish ${i + 1} verdict "${dish.verdictAnswer}" is not 推荐 or 避雷; leave it out`);
    }
  }
  if (!hasText && !hasRating && links === 0) {
    blockers.push('neither a valid rating, review text, dishes, nor photos were submitted');
  }
  if (!hasText && !hasRating && links > 0 && usable === 0) {
    blockers.push('photo-only submission without any retrieved photo: retry, add the photos by hand, or reject');
  }
  if (unresolved.length > 0) {
    notes.push(
      `photo intake incomplete (photo ${unresolved.join(', ')} missing): run retry-photos, add them with ` +
        'add-photo, or waive them if the maintainer decides to proceed without them',
    );
  }
  if (submission.ratingAnswer && !hasRating) {
    notes.push(`rating answer "${submission.ratingAnswer}" is not one of the five levels; leave the rating out`);
  } else if (!submission.ratingAnswer) {
    notes.push('no overall rating (optional in older form versions): leave the rating out');
  }
  if (!submission.email) notes.push('no contact email: questions cannot be sent back to the contributor');
  if (!submission.displayName) notes.push('no display name: credit it as 匿名 (the form says so)');
  return { blockers, notes, photos: photoSummary(state) };
}

// ---------------------------------------------------------------------------
// Processing log and import

export const LOG_FILE = 'tally-log.json';
/** Editorial status, separate from photo retrieval (see PhotoSummary). */
/**
 * deferred: kept but not used, because the restaurant already has an
 * accepted contributor (one review per restaurant for now); saved for a
 * future multi-review database.
 */
export const LOG_STATUSES = ['imported', 'drafted', 'processed', 'deferred', 'rejected'] as const;
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
      /** The submitted POI ("provider:id"), private. With restaurantId it links that POI to the restaurant. */
      poi: z.string().optional(),
      /**
       * Set when prepare wrote this submission's content into a draft, cleared
       * when a rejection took it out again. Evidence only: the rollback state
       * itself lives in prepare.json. With this set, a missing prepare.json is
       * lost state, not "never prepared".
       */
      draftWritten: z.boolean().optional(),
      /** Explicit maintainer decisions about this submission (e.g. lost prepare state), oldest first. */
      audit: z.array(z.strictObject({ at: z.string(), action: z.string(), note: z.string() })).optional(),
    })
    .strict(),
);
export type SubmissionLog = z.infer<typeof logSchema>;
export type LogEntry = SubmissionLog[string];

/**
 * The private processing log (private/submissions/tally-log.json) records
 * every imported submission id and its editorial status. The status never
 * decides whether the raw submission is kept: it always is (only an explicit
 * erasure request removes it, see docs/submissions.md#retention), and the log
 * still prevents a second import if that happens.
 */
export async function readLog(submissionsDir: string): Promise<SubmissionLog> {
  const file = path.join(submissionsDir, LOG_FILE);
  if (!existsSync(file)) return {};
  return logSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** Changes one log entry (atomically). */
export async function updateLog(submissionsDir: string, id: string, change: (entry?: LogEntry) => LogEntry) {
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

/**
 * POIs linked to restaurants by reviewed submissions (drafted or processed
 * with a restaurant id), so later submissions of the same POI are matched.
 */
export function poiIndexFromLog(log: SubmissionLog): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of Object.values(log)) {
    if (entry.poi && entry.restaurantId && (entry.status === 'drafted' || entry.status === 'processed')) {
      index.set(entry.poi, entry.restaurantId);
    }
  }
  return index;
}

export const submissionDir = (submissionsDir: string, id: string) => path.join(submissionsDir, `tally-${id}`);

export interface SubmissionReport {
  submission: Submission;
  /**
   * new: imported now; resumed: imported before, photo intake continued;
   * duplicate: imported before with complete photo intake, nothing to do;
   * missing: imported before, but its raw files are gone (erased on request,
   * or lost: restore them from the private backup).
   */
  outcome: 'new' | 'resumed' | 'duplicate' | 'missing' | 'status';
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
  const known = {
    restaurants: await loadKnownRestaurants(options.restaurantsDir, options.draftsDir),
    poiIndex: poiIndexFromLog(await readLog(options.submissionsDir)),
  };
  // Earlier imports and this export, for duplicate and repeat checks.
  const others = [
    ...(await storedReviewTexts(options.submissionsDir)),
    ...submissions.map(reviewTextOf),
  ];
  const reports: SubmissionReport[] = [];
  for (const incoming of submissions) {
    const id = incoming.submissionId;
    const dir = submissionDir(options.submissionsDir, id);
    const logged = (await readLog(options.submissionsDir))[id];
    const stored = existsSync(path.join(dir, SUBMISSION_FILE));
    if (logged && !stored) {
      reports.push(report(incoming, 'missing', known, [], { entry: logged }));
      continue;
    }
    // The stored record is kept; a differing export is reported, not merged.
    const submission = stored ? await readStoredSubmission(dir) : incoming;
    const extra: string[] = [];
    if (stored && JSON.stringify(submission) !== JSON.stringify(incoming)) {
      extra.push('this export differs from the stored submission; the stored one was kept');
    }
    extra.push(...reviewHints(reviewTextOf(submission), others));
    if (!stored) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, SUBMISSION_FILE), `${JSON.stringify(submission, null, 2)}\n`, { flag: 'wx' });
    }
    let state = await loadPhotoState(dir, submission);
    const entry = await updateLog(options.submissionsDir, id, (e) =>
      e ?? {
        status: 'imported',
        importedAt: now(),
        ...(submission.poi ? { poi: poiKey(submission.poi) } : {}),
      },
    );
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

/** The text an editor reviews for hints: the review and the dish comments. */
function reviewTextOf(s: Submission): ReviewText {
  return {
    submissionId: s.submissionId,
    restaurant: s.restaurantId ?? s.restaurantName?.trim(),
    email: s.email,
    text: [s.review, ...s.dishes.map((d) => d.comment)].filter((t) => t?.trim()).join('\n'),
  };
}

/** Review texts of the submissions stored by earlier imports. */
async function storedReviewTexts(submissionsDir: string): Promise<ReviewText[]> {
  const texts: ReviewText[] = [];
  for (const id of Object.keys(await readLog(submissionsDir))) {
    const dir = submissionDir(submissionsDir, id);
    if (existsSync(path.join(dir, SUBMISSION_FILE))) {
      texts.push(reviewTextOf(await readStoredSubmission(dir)));
    }
  }
  return texts;
}

/** Loads a stored submission for retry-photos, add-photo, waive-photo, and status. */
export async function openSubmission(submissionsDir: string, id: string) {
  const entry = (await readLog(submissionsDir))[id];
  if (!entry) throw new IntakeError(`submission "${id}" has not been imported`);
  const dir = submissionDir(submissionsDir, id);
  if (!existsSync(path.join(dir, SUBMISSION_FILE))) {
    throw new IntakeError(
      `the raw files of submission "${id}" are missing (status ${entry.status}); restore private/ from the ` +
        'private backup (docs/submissions.md#retention), unless they were erased on request',
    );
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
  photos?: PhotoState[],
): Promise<SubmissionReport> {
  const { dir, submission } = await openSubmission(options.submissionsDir, id);
  const state = photos ?? (await loadPhotoState(dir, submission));
  const entry = await updateLog(options.submissionsDir, id, (e) => ({ ...e!, photos: photoSummary(state) }));
  const known = {
    restaurants: await loadKnownRestaurants(options.restaurantsDir, options.draftsDir),
    poiIndex: poiIndexFromLog(await readLog(options.submissionsDir)),
  };
  const extra = reviewHints(reviewTextOf(submission), await storedReviewTexts(options.submissionsDir));
  return report(submission, 'status', known, state, { entry, dir, extra });
}

function report(
  submission: Submission,
  outcome: SubmissionReport['outcome'],
  known: { restaurants: KnownRestaurant[]; poiIndex: Map<string, string> },
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
    identity: resolveIdentity(submission, known.restaurants, known.poiIndex),
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
  if (result.outcome === 'missing') {
    lines.push(
      `  already imported ${entry!.importedAt} (status ${entry!.status}` +
        `${entry!.restaurantId ? `, restaurant ${entry!.restaurantId}` : ''}); its raw files are missing, nothing written: ` +
        'restore them from the private backup unless they were erased on request',
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
  lines.push(`  selected:   ${describeSelection(s)}`);
  const kind = [
    result.rating !== undefined && 'rating',
    s.review?.trim() && 'review text',
    s.dishes.length && `${s.dishes.length} dish(es)`,
    s.photoUrls.length && `${s.photoUrls.length} general photo(s)`,
  ]
    .filter(Boolean)
    .join(' + ');
  lines.push(`  content:    ${kind || 'nothing'}`);
  for (const [i, dish] of s.dishes.entries()) {
    const verdict = verdictFromAnswer(dish.verdictAnswer);
    const photos = result.photos.filter((p) => p.dish === i + 1).map((p) => p.slot);
    lines.push(
      `    dish ${i + 1}  ${dish.name?.trim() ? `"${dish.name.trim()}"` : '(no name)'}; ` +
        `verdict ${verdict === 1 ? '1 (推荐)' : verdict === -1 ? '-1 (避雷)' : 'none'}; ` +
        `${dish.comment?.trim() ? 'comment' : 'no comment'}; ` +
        `${photos.length ? `photo ${photos.join(', ')}` : 'no photo'}`,
    );
  }
  lines.push(`  rating:     ${result.rating ?? 'none'}`);
  lines.push(
    `  credit:     ${s.displayName ? `display name "${s.displayName}"` : 'no display name (credit as 匿名)'}; ` +
      `${s.email ? 'contact email provided (private)' : 'no contact email'}`,
  );
  lines.push(`  consent:    ${s.consent ? 'yes' : 'NO'}`);
  lines.push(`  photos:     ${photoSummary(result.photos)}`);
  for (const p of result.photos) {
    const detail = p.file ? rel(path.join(result.dir!, p.file)) : (p.error ?? '');
    const tries = p.attempts > 0 ? ` (${p.attempts} attempt${p.attempts > 1 ? 's' : ''})` : '';
    const owner = p.dish ? ` [dish ${p.dish}]` : '';
    lines.push(`    ${String(p.slot).padStart(2)}  ${p.status.padEnd(10)} ${detail}${tries}${owner}`);
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

function describeSelection(s: Submission): string {
  const parts = [
    `method ${s.selectionMethod ?? '(unknown)'}`,
    s.restaurantName?.trim() ? `name "${s.restaurantName.trim()}"` : 'no name',
    ...(s.restaurantAltNames.length ? [`other names ${s.restaurantAltNames.map((n) => `"${n}"`).join(', ')}`] : []),
    s.restaurantAddress?.trim() ? `address "${s.restaurantAddress.trim()}"` : 'no address',
    s.restaurantLocation
      ? `at ${s.restaurantLocation.lat.toFixed(6)},${s.restaurantLocation.lng.toFixed(6)}`
      : 'no location',
    s.poi ? `POI ${poiKey(s.poi)} (private)` : 'no POI',
  ];
  return parts.join('; ');
}

export function describeIdentity(identity: Identity, s: Submission): string {
  const label = (r: KnownRestaurant) =>
    `${r.id} "${r.name}"${r.address ? ` (${r.address})` : ''}${r.where === 'draft' ? ' [private draft]' : ''}`;
  const candidate = (c: Candidate) => {
    const near = c.distance !== undefined && c.distance <= NEARBY_METERS;
    const how =
      c.nameMatch && near
        ? 'same name nearby'
        : c.nameMatch
          ? c.distance !== undefined
            ? `same name ${Math.round(c.distance)} m away: possibly another branch`
            : 'same name, location unknown: possibly another branch'
          : `different name ${Math.round(c.distance!)} m away`;
    return `${label(c.restaurant)} [${how}]`;
  };
  const others = (list: Candidate[]) => (list.length ? `; candidates: ${list.map(candidate).join(', ')}` : '');
  const name = s.restaurantName?.trim();
  switch (identity.kind) {
    case 'existing':
      return `existing ${label(identity.restaurant)}; update it with content:edit only as the maintainer decides`;
    case 'conflict':
      return (
        `CONFLICT: id ${identity.restaurant.id} is "${identity.restaurant.name}" but ${identity.reason}` +
        `${others(identity.candidates)}; ask the maintainer`
      );
    case 'unknown-id':
      return `UNKNOWN id "${identity.id}" (not in the database)${others(identity.candidates)}; ask the maintainer`;
    case 'poi-match':
      return (
        `same map listing as ${label(identity.restaurant)} in an earlier reviewed submission; ` +
        'confirm before updating it'
      );
    case 'candidates':
      return `"${name ?? '(no name)'}" without an id${others(identity.candidates)}; compare locations before deciding`;
    case 'new':
      return `"${name ?? '(no name)'}": nothing similar in the database; a new draft may be needed`;
    case 'unidentified':
      return 'no restaurant id, name, or location; ask the contributor or the maintainer';
  }
}
