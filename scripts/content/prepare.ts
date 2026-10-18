// Deterministic preparation of a private draft from an imported Tally
// submission (docs/submissions.md, "Prepare a draft"):
//
//   private/submissions/tally-<id>/   raw submission (submission.json, photos)
//     -> resolve the restaurant and the contributor, map keywords to tags,
//        add restaurant information from the map listing, import every photo
//        with its dish
//     -> private/drafts/<restaurant id>/   draft for the maintainer's review:
//        the restaurant (info.json) and this contributor's review
//        (reviews/<contributor id>.json and .md)
//     -> private/submissions/tally-<id>/review-report.md
//
// Everything with fixed rules is done here, without a language model: field
// mapping, rating and verdicts, photo ownership, restaurant and contributor
// matching, validation, the report. What needs judgment (unknown keywords,
// facts from a restaurant's website or menu) is left as pending items; the
// restaurant-intake Skill may answer them in resolutions.json, which is
// validated here before anything is used. Nothing is promoted, published, or
// committed.
//
// Every accepted submission is one review of its restaurant: a submission
// about a restaurant that already has reviews adds its own, and a later
// submission by the same contributor (same email) updates their review.
// The restaurant's facts are only ever filled in where they are empty; each
// dish is matched to the restaurant's dishes by name (or other name), and a
// new name becomes a new dish.
//
// Re-running is safe: the draft id, the contributor, and the photo -> image
// mapping are stored in prepare.json, so nothing is created twice, and a
// review edited by hand since the last run is never overwritten (unless
// --rebuild). Images an earlier run imported that no longer belong to the
// submission are removed; images added by hand are kept.
//
// Rejecting a submission (rejectSubmission) takes its review back out of the
// draft (or restores the contributor's earlier review) with its photos, and
// undoes what it added to the restaurant: prepare.json keeps the restaurant
// as it was before (base) and as prepare wrote it, so the maintainer's and
// other reviews' additions are kept. When a fact was changed both by the
// submission and by hand, nothing is changed and the draft cannot be
// promoted until the maintainer resolves it. The raw submission is always
// kept.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  contributorIdSchema,
  idSchema,
  normalizeKeyword,
  restaurantInfoSchema,
  reviewSchema,
  tagIdSchema,
  type RestaurantInfo,
  type Review,
} from '../../shared/content/schema.ts';
import type { Rating } from '../../shared/content/vocabulary.ts';
import { isValidLatLng, ratingFromAnswer, verdictFromAnswer } from '../../shared/submission.ts';
import { resolveContributor, type ContributorFiles } from './contributors.ts';
import {
  factSchema,
  poiDetails,
  verifyListing,
  type ExpectedPlace,
  type Fact,
  type ListingCheck,
  type PoiDetails,
} from './enrich.ts';
import { checkoutRestaurant, createDraft, folderChanges, importImages, IntakeError, newRestaurantId } from './intake.ts';
import { IMAGES_DIR, INFO_FILE, listImages, REVIEWS_DIR, reviewImages, runPipeline } from './pipeline.ts';
import { findContactDetails, tagRegistryProblems } from './privacy.ts';
import {
  loadKnownRestaurants,
  loadPhotoState,
  openSubmission,
  poiIndexFromLog,
  readiness,
  readLog,
  describeIdentity,
  resolveIdentity,
  markSubmission,
  submissionDir,
  updateLog,
  type LogStatus,
  type NetworkOptions,
  type PhotoState,
  type Submission,
} from './submissions.ts';
import {
  allTags,
  loadTags,
  lookupTag,
  matchedTagIds,
  matchKeywords,
  recordDecisions,
  withdrawTags,
  type KeywordMatch,
  type TagDecision,
  type TagFiles,
} from './tags.ts';

export const PREPARE_STATE_FILE = 'prepare.json';
export const RESOLUTIONS_FILE = 'resolutions.json';
export const REVIEW_REPORT_FILE = 'review-report.md';

/** What prepare remembers between runs (private, next to submission.json). */
const prepareStateSchema = z.strictObject({
  restaurantId: idSchema,
  /** new: a restaurant created from this submission; existing: one already in the database or a draft. */
  mode: z.enum(['new', 'existing']),
  /** The restaurant before this submission touched it; a rejection restores what it added. */
  base: z.strictObject({
    info: z.record(z.string(), z.unknown()),
    /** The contributor's earlier review (its .json and .md text), which this submission updates. */
    review: z.strictObject({ json: z.string(), md: z.string().optional() }).optional(),
    /** Image files the draft had before (never removed by prepare or a rejection). */
    images: z.array(z.string()),
  }),
  /** True when prepare created the draft folder (new restaurant, or a checkout of a public one). */
  createdDraft: z.boolean(),
  contributorId: contributorIdSchema.optional(),
  /** Submitted photo slot -> stored image (and the stored file's SHA-256), so photos are imported once. */
  photos: z.array(
    z.strictObject({ slot: z.number().int().min(1), sha256: z.string(), image: z.string(), stored: z.string() }),
  ),
  /** Tags this submission proposed (private/tags.json), withdrawn again if it is rejected. */
  proposedTags: z.array(tagIdSchema),
  /** Fingerprint of this submission's review and photos as prepare last wrote them (detects hand edits); absent when nothing of it is in the draft. */
  written: z.string().optional(),
  /** info.json as prepare last wrote it, for a rejection. */
  writtenInfo: z.record(z.string(), z.unknown()).optional(),
  /** What happened when the submission was rejected (see rejectSubmission). */
  rejection: z
    .strictObject({
      /** pending: started, not finished; manual: needs the maintainer; done; resolved: by the maintainer. */
      status: z.enum(['pending', 'manual', 'done', 'resolved']),
      at: z.string(),
      details: z.array(z.string()),
    })
    .optional(),
  preparedAt: z.string(),
});
export type PrepareState = z.infer<typeof prepareStateSchema>;

/**
 * Answers to pending items, written by the Skill (or the maintainer) as
 * structured data. Validated against the submission and the registry before
 * use: a keyword must be one the contributor typed, a tag must exist (or be
 * proposed with an id and label), and every fact needs a source and evidence.
 */
export const resolutionsSchema = z.strictObject({
  tags: z
    .array(
      z.union([
        z.strictObject({ keyword: z.string().min(1), tag: tagIdSchema }),
        z.strictObject({
          keyword: z.string().min(1),
          newTag: z.strictObject({ id: tagIdSchema, label: z.string().trim().min(1).max(20) }),
        }),
        z.strictObject({ keyword: z.string().min(1), skip: z.string().trim().min(1).max(200) }),
      ]),
    )
    .default([]),
  facts: z.array(factSchema).default([]),
  /**
   * The maintainer's decision about a map listing that could not be verified
   * automatically (or was wrongly accepted), for the listing with this key.
   * Kept in resolutions.json as the record of who decided what and why.
   */
  listing: z
    .strictObject({
      key: z.string().min(1),
      decision: z.enum(['same-place', 'different-place']),
      reason: z.string().trim().min(1).max(300),
    })
    .optional(),
});
export type Resolutions = z.infer<typeof resolutionsSchema>;

export interface PrepareOptions extends NetworkOptions {
  submissionsDir: string;
  restaurantsDir: string;
  draftsDir: string;
  contributorFiles: ContributorFiles;
  tagFiles: TagFiles;
  /** private/cache: place details and evidence pages. */
  cacheDir: string;
  /** Image rendition cache used for validation (.cache/images). */
  imageCacheDir: string;
  /** The maintainer's decision: the submission is about this existing restaurant. */
  restaurantId?: string;
  /** The maintainer's decision: a new restaurant, even though similar ones exist. */
  asNew?: boolean;
  /** Rebuild the draft even if it was edited by hand since the last run. */
  rebuild?: boolean;
  /** No network: cached place details only. */
  offline?: boolean;
  /** Look the map listing up again instead of using the cache. */
  refresh?: boolean;
  geoapifyKey?: string;
  now?: () => string;
}

export type PrepareOutcome =
  /** A draft was created or updated. */
  | 'drafted'
  /** Nothing changed since the last run. */
  | 'unchanged'
  /** The review was edited by hand since the last run; left as it is. */
  | 'edited'
  /** Cannot be prepared until something is decided or fixed (see blockers). */
  | 'blocked'
  /** Already promoted or processed; nothing to do. */
  | 'done';

export interface AppliedFact {
  fact: Fact;
  applied: boolean;
  /** Why it was not applied. */
  reason?: string;
}

export interface PrepareReport {
  submission: Submission;
  outcome: PrepareOutcome;
  restaurantId?: string;
  mode?: 'new' | 'existing';
  identity: string;
  /** True when it updates the contributor's earlier review of the restaurant. */
  updatesReview?: boolean;
  draftDir?: string;
  contributor?: { id: string; created: boolean; name: string };
  rating?: number;
  dishes: { name?: string; verdict?: number; comment: boolean; images: string[]; dish?: string; newDish?: boolean }[];
  keywords: KeywordMatch[];
  newTags: string[];
  photos: { total: number; imported: number; waived: number; excluded: number; unresolved: number[] };
  poi?: PoiDetails;
  /** Whether the map listing is the intended restaurant; only a verified listing's facts are applied. */
  listing?: ListingCheck & { decidedBy?: 'maintainer' };
  facts: AppliedFact[];
  /** Fields this run filled in (or would). */
  filled: string[];
  conflicts: string[];
  missing: string[];
  privacy: string[];
  consent: boolean;
  blockers: string[];
  notes: string[];
  /** Images an earlier run imported that no longer belong to the submission, removed now. */
  removedImages: string[];
  /** Images in the draft that are neither from this submission nor from before it (kept). */
  otherImages: string[];
  /** Files that would become public (or change) when the draft is promoted. */
  publicChanges: string[];
  /** content:check problems of the draft. */
  diagnostics: string[];
}

const now = () => new Date().toISOString();

async function writeAtomic(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function readState(dir: string): Promise<PrepareState | undefined> {
  const file = path.join(dir, PREPARE_STATE_FILE);
  if (!existsSync(file)) return undefined;
  return prepareStateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** Fingerprint of a draft folder: every file's path and contents. */
export async function draftFingerprint(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const entries = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
  for (const file of entries) {
    hash.update(`${file}\0`);
    hash.update(await readFile(path.join(dir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Restaurant fields in the order of the schema (docs/content.md), for readable diffs. */
const FIELD_ORDER = [
  'id',
  'status',
  'name',
  'altNames',
  'address',
  'location',
  'cuisines',
  'tags',
  'pricePerPerson',
  'dishes',
  'links',
] as const;
const ordered = (info: Record<string, unknown>) =>
  Object.fromEntries(
    [...FIELD_ORDER, ...Object.keys(info).filter((k) => !(FIELD_ORDER as readonly string[]).includes(k))]
      .filter((k) => info[k] !== undefined)
      .map((k) => [k, info[k]]),
  );

/** Validates resolutions.json against the submission and the registry; problems are reported, not thrown. */
export function checkResolutions(
  raw: unknown,
  submission: Submission,
  registry: Awaited<ReturnType<typeof loadTags>>,
): { decisions: TagDecision[]; facts: Fact[]; listing?: Resolutions['listing']; problems: string[] } {
  const parsed = resolutionsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      decisions: [],
      facts: [],
      problems: parsed.error.issues.map((i) => `${RESOLUTIONS_FILE}: ${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const problems: string[] = [];
  const submitted = new Set(submission.keywords.map(normalizeKeyword));
  const decisions: TagDecision[] = [];
  for (const entry of parsed.data.tags) {
    if (!submitted.has(normalizeKeyword(entry.keyword))) {
      problems.push(`${RESOLUTIONS_FILE}: "${entry.keyword}" is not one of the contributor's keywords; ignored`);
      continue;
    }
    if ('tag' in entry) {
      if (!allTags(registry).some((t) => t.id === entry.tag)) {
        problems.push(`${RESOLUTIONS_FILE}: tag "${entry.tag}" does not exist; propose it as newTag instead`);
        continue;
      }
      decisions.push(entry);
    } else if ('newTag' in entry) {
      const { id, label } = entry.newTag;
      // Labels (also ones a model proposed) become public: contact details never pass.
      const found = tagRegistryProblems([entry.newTag]);
      if (found.unsafe.length || /[<>]/.test(label)) {
        problems.push(
          `${RESOLUTIONS_FILE}: new tag not used: ${found.unsafe.join('; ') || `tag "${id}" label "${label}": contains "<" or ">"`}`,
        );
        continue;
      }
      for (const q of found.questionable) problems.push(`review the new tag: ${q}; it becomes public on promotion`);
      const existing = allTags(registry).find((t) => t.id === id) ?? lookupTag(registry, label);
      if (existing) {
        problems.push(`new tag "${id}" ("${label}") matches the existing tag "${existing.id}"; using that`);
        decisions.push({ keyword: entry.keyword, tag: existing.id });
      } else {
        decisions.push({ keyword: entry.keyword, newTag: { id, label } });
      }
    } else {
      decisions.push(entry);
    }
  }
  return { decisions, facts: parsed.data.facts, listing: parsed.data.listing, problems };
}

/**
 * Applies facts to a restaurant without overwriting anything: a field is set
 * only when it is empty; a different existing value is a conflict for the
 * reviewer. Low-confidence facts are reported, never applied.
 */
export function applyFacts(
  info: Record<string, unknown>,
  facts: Fact[],
  filled: string[],
  conflicts: string[],
  /** Fields the record had before this submission; only those make conflicts. */
  recorded: ReadonlySet<string> = new Set(),
): AppliedFact[] {
  return facts.map((fact): AppliedFact => {
    if (fact.confidence === 'low') return { fact, applied: false, reason: 'low confidence' };
    const describe = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));
    if (fact.field === 'altNames') {
      const current = (info.altNames as string[] | undefined) ?? [];
      const name = normalizeKeyword(String(info.name ?? ''));
      const added = fact.value.filter(
        (n) => normalizeKeyword(n) !== name && !current.some((c) => normalizeKeyword(c) === normalizeKeyword(n)),
      );
      if (added.length === 0) return { fact, applied: false, reason: 'already known' };
      info.altNames = [...current, ...added];
      filled.push(`altNames (+${added.join(', ')})`);
      return { fact, applied: true };
    }
    const key = fact.field === 'website' ? 'links.website' : fact.field;
    const current = fact.field === 'website' ? (info.links as { website?: string } | undefined)?.website : info[fact.field];
    const empty = current === undefined || (Array.isArray(current) && current.length === 0);
    if (!empty) {
      if (JSON.stringify(current) === JSON.stringify(fact.value)) return { fact, applied: false, reason: 'already known' };
      if (!recorded.has(fact.field)) {
        return { fact, applied: false, reason: `the submission or an earlier source gives "${describe(current)}"` };
      }
      conflicts.push(`${key}: the record has "${describe(current)}", ${fact.source} says "${describe(fact.value)}"; not changed`);
      return { fact, applied: false, reason: 'conflicts with the record' };
    }
    if (fact.field === 'website') info.links = { ...(info.links as object | undefined), website: fact.value };
    else info[fact.field] = fact.value;
    filled.push(key);
    return { fact, applied: true };
  });
}


export async function prepareSubmission(id: string, options: PrepareOptions): Promise<PrepareReport> {
  const clock = options.now ?? now;
  const { dir, submission } = await openSubmission(options.submissionsDir, id);
  const log = await readLog(options.submissionsDir);
  const entry = log[id]!;
  const photoState = await loadPhotoState(dir, submission);
  const ready = readiness(submission, photoState);
  let state = await readState(dir);
  const registry = await loadTags(options.tagFiles);

  const report: PrepareReport = {
    submission,
    outcome: 'blocked',
    identity: '',
    rating: ratingFromAnswer(submission.ratingAnswer),
    dishes: [],
    keywords: [],
    newTags: [],
    photos: photoCounts(photoState),
    facts: [],
    filled: [],
    conflicts: [],
    missing: [],
    privacy: [],
    consent: submission.consent,
    blockers: [...ready.blockers],
    notes: [...ready.notes],
    removedImages: [],
    otherImages: [],
    publicChanges: [],
    diagnostics: [],
  };
  const finish = async (outcome: PrepareOutcome) => {
    report.outcome = outcome;
    await writeAtomic(path.join(dir, REVIEW_REPORT_FILE), formatPrepareReport(report, (f) => f));
    return report;
  };

  // Resolutions (optional) and keyword matching, also for blocked submissions' reports.
  const resolutionsFile = path.join(dir, RESOLUTIONS_FILE);
  let decisions: TagDecision[] = [];
  let decidedFacts: Fact[] = [];
  let listingDecision: Resolutions['listing'];
  if (existsSync(resolutionsFile)) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(resolutionsFile, 'utf8'));
    } catch (e) {
      report.notes.push(`${RESOLUTIONS_FILE}: invalid JSON (${(e as Error).message}); ignored`);
    }
    if (raw !== undefined) {
      const checked = checkResolutions(raw, submission, registry);
      decisions = checked.decisions;
      decidedFacts = checked.facts;
      listingDecision = checked.listing;
      report.notes.push(...checked.problems);
    }
  }
  report.keywords = matchKeywords(submission.keywords, registry, decisions);
  report.newTags = [
    ...new Set(report.keywords.flatMap((k) => (k.via === 'decision' && k.created ? [k.tag] : []))),
  ];

  if (entry.status === 'rejected') report.blockers.push('the submission was marked rejected');
  if (!state && entry.draftWritten) report.blockers.push(lostStateMessage(id, entry.restaurantId, entry.status));
  const open = unfinishedRejection(state);
  if (open) {
    report.blockers.push(
      `its rejection is ${open.status === 'manual' ? 'waiting for the maintainer' : 'unfinished'}: finish it with ` +
        `"npm run content:submission -- mark ${id} --status rejected" before preparing it again`,
    );
  }
  if (entry.status === 'processed') {
    report.notes.push('already processed (its restaurant was promoted); nothing to prepare');
    return finish('done');
  }
  if (report.photos.unresolved.length > 0) {
    report.blockers.push(
      `photo ${report.photos.unresolved.join(', ')} not retrieved: run retry-photos, add-photo, or waive-photo first, ` +
        'so every photo keeps its dish',
    );
  }
  const email = submission.email?.trim();
  const validEmail = email && z.email().safeParse(email).success ? email : undefined;
  if (email && !validEmail) report.notes.push('the contact email is not a valid address; it is kept only in submission.json');
  if (submission.displayName?.includes('@') || findContactDetails(submission.displayName ?? '').length) {
    report.blockers.push('the display name looks like contact details; ask the contributor which name to credit');
  }

  // Restaurant identity: the stored decision, the maintainer's decision, or a safe automatic match.
  const known = await loadKnownRestaurants(options.restaurantsDir, options.draftsDir);
  const identity = resolveIdentity(submission, known, poiIndexFromLog(log));
  report.identity = describeIdentity(identity, submission);
  let restaurantId = state?.restaurantId;
  let mode = state?.mode;
  if (!restaurantId && options.restaurantId) {
    if (!known.some((r) => r.id === options.restaurantId)) {
      report.blockers.push(`--id ${options.restaurantId}: no such restaurant in content/ or private/drafts/`);
    } else {
      restaurantId = options.restaurantId;
      mode = 'existing';
    }
  } else if (!restaurantId && identity.kind === 'existing') {
    restaurantId = identity.restaurant.id;
    mode = 'existing';
  } else if (!restaurantId && (identity.kind === 'new' || options.asNew)) {
    if (!submission.restaurantName?.trim()) report.blockers.push('a new restaurant needs a name');
    else mode = 'new';
  } else if (!restaurantId) {
    report.blockers.push(
      'the restaurant match needs the maintainer: run prepare again with --id <restaurant id> for an existing ' +
        'restaurant, or --new for a new one',
    );
  }
  report.mode = mode;
  report.restaurantId = restaurantId;
  if (report.blockers.length > 0) return finish('blocked');

  const draftDir = (rid: string) => path.join(options.draftsDir, rid);
  const publicDir = (rid: string) => path.join(options.restaurantsDir, rid);
  const reviewFile = (root: string, cid: string, ext: 'json' | 'md') => path.join(root, REVIEWS_DIR, `${cid}.${ext}`);
  // A review that was already promoted from this submission's draft.
  if (state?.contributorId && !existsSync(draftDir(state.restaurantId))) {
    if (existsSync(reviewFile(publicDir(state.restaurantId), state.contributorId, 'json'))) {
      report.notes.push(`the draft was promoted to content/restaurants/${state.restaurantId}/; mark the submission processed`);
      return finish('done');
    }
  }

  // From here on the draft is ours to build.
  if (!restaurantId) {
    const taken = new Set(known.map((r) => r.id));
    for (const root of [options.restaurantsDir, options.draftsDir]) {
      if (existsSync(root)) for (const folder of await readdir(root)) taken.add(folder);
    }
    restaurantId = newRestaurantId(taken);
    report.restaurantId = restaurantId;
  }
  const target = draftDir(restaurantId);
  report.draftDir = target;

  // Contributor: found by email, or registered privately. Known before the
  // draft is touched, since their earlier review (if any) is what this updates.
  let contributorId = state?.contributorId;
  if (!contributorId) {
    const contributor = await resolveContributor(options.contributorFiles, {
      name: submission.displayName,
      email: validEmail,
    });
    contributorId = contributor.id;
    report.contributor = { id: contributor.id, created: contributor.created, name: submission.displayName?.trim() || '匿名' };
    report.notes.push(...contributor.notes);
  } else {
    report.contributor = { id: contributorId, created: false, name: submission.displayName?.trim() || '匿名' };
  }

  if (!state) {
    let base: PrepareState['base'];
    let createdDraft = false;
    if (existsSync(path.join(target, INFO_FILE))) {
      base = await snapshot(target, contributorId);
    } else if (mode === 'existing') {
      base = await snapshot(publicDir(restaurantId), contributorId);
      base.info.status = 'draft';
      createdDraft = true;
    } else {
      base = { info: { id: restaurantId, status: 'draft', name: submission.restaurantName!.trim() }, images: [] };
      createdDraft = true;
    }
    state = { restaurantId, mode: mode!, base, createdDraft, contributorId, photos: [], proposedTags: [], preparedAt: clock() };
    await writeAtomic(path.join(dir, PREPARE_STATE_FILE), json(state));
  }
  report.updatesReview = !!state.base.review;
  if (report.updatesReview) report.notes.push(`updates ${contributorId}'s earlier review of this restaurant (one review per contributor)`);

  // Hand edits of this review since the last run are never overwritten (unless --rebuild).
  const own = () => ownFingerprint(target, contributorId!, state!.photos.map((m) => m.image));
  if (existsSync(reviewFile(target, contributorId, 'json')) && state.written && !options.rebuild) {
    if ((await own()) !== state.written) {
      report.notes.push(
        'the review was edited by hand since the last prepare; nothing was changed (use --rebuild to rebuild it ' +
          'from the submission, discarding those edits)',
      );
      await describeDraft(report, target, restaurantId, options);
      return finish('edited');
    }
  }
  if (!existsSync(path.join(target, INFO_FILE))) {
    if (state.mode === 'existing' && existsSync(path.join(publicDir(restaurantId), INFO_FILE))) {
      await checkoutRestaurant(options.restaurantsDir, options.draftsDir, restaurantId);
    } else if (state.mode === 'new') {
      await createDraft(options.draftsDir, restaurantId, String(state.base.info.name));
    } else {
      report.blockers.push(`restaurant ${restaurantId} no longer exists`);
      return finish('blocked');
    }
  }
  const before = `${await own()}|${await readFile(path.join(target, INFO_FILE), 'utf8')}`;

  // Photos: every retrieved photo once, in submission order (general photos first,
  // so the cover is a general photo when there is one); each dish keeps its own.
  const imagesDir = path.join(target, IMAGES_DIR);
  const images = existsSync(imagesDir) ? new Set(await readdir(imagesDir)) : new Set<string>();
  const usable = photoState.filter((p) => (p.status === 'downloaded' || p.status === 'recovered') && p.file && p.sha256);
  const saveState = () => writeAtomic(path.join(dir, PREPARE_STATE_FILE), json(state));
  /** Removes an image this submission imported, unless another slot still uses it or it was changed by hand. */
  const removeOwnImage = async (mapping: PrepareState['photos'][number]) => {
    const file = path.join(target, mapping.image);
    if (state!.photos.some((m) => m.image === mapping.image)) return false;
    if (!images.has(path.basename(mapping.image)) || (await fileHash(file)) !== mapping.stored) return false;
    await rm(file);
    images.delete(path.basename(mapping.image));
    report.removedImages.push(mapping.image);
    return true;
  };
  // A photo that no longer belongs to the submission (its slot was waived or
  // its file changed) takes its image with it.
  for (const mapping of state.photos.filter((m) => !usable.some((p) => p.slot === m.slot))) {
    state.photos = state.photos.filter((m) => m !== mapping);
    await removeOwnImage(mapping);
    await saveState();
  }
  for (const photo of usable) {
    const mapped = state.photos.find((m) => m.slot === photo.slot);
    if (mapped && mapped.sha256 === photo.sha256 && images.has(path.basename(mapped.image))) continue;
    // The same picture uploaded twice is stored once.
    const twin = state.photos.find((m) => m.sha256 === photo.sha256 && images.has(path.basename(m.image)));
    let entry = twin && { image: twin.image, stored: twin.stored };
    // A replaced photo takes the place (number) of the one it replaces, so the order and the cover stay.
    let number: string | undefined;
    if (mapped) {
      state.photos = state.photos.filter((m) => m !== mapped);
      if (mapped.sha256 !== photo.sha256 && (await removeOwnImage(mapped))) {
        number = /^(\d+)-/.exec(path.basename(mapped.image))?.[1];
      }
    }
    if (!entry) {
      const [stored] = await importImages(
        target,
        [path.join(dir, photo.file!)],
        [photo.dish ? `dish-${photo.dish}` : 'photo'],
        [number],
      );
      images.add(path.basename(stored!.stored));
      entry = { image: `${IMAGES_DIR}/${path.basename(stored!.stored)}`, stored: (await fileHash(stored!.stored))! };
    }
    state.photos = [...state.photos, { slot: photo.slot, sha256: photo.sha256!, ...entry }].sort((a, b) => a.slot - b.slot);
    await saveState();
  }
  report.photos.imported = new Set(state.photos.map((m) => m.image)).size;
  const imageOf = (p: PhotoState) => state!.photos.find((m) => m.slot === p.slot)?.image;
  // The contributor's earlier review keeps its photos; this one adds its own.
  const previous = state.base.review ? (reviewSchema.parse(JSON.parse(state.base.review.json)) as Review) : undefined;
  // Images neither from this submission nor from before it (added by hand): kept, reported.
  report.otherImages = [...images]
    .map((name) => `${IMAGES_DIR}/${name}`)
    .filter((image) => !state!.photos.some((m) => m.image === image) && !state!.base.images.includes(image))
    .sort();

  // Restaurant information from the map listing (cached; failures never block).
  const poi = await poiDetails(
    { poi: submission.poi, name: submission.restaurantName, location: submission.restaurantLocation },
    {
      cacheDir: options.cacheDir,
      geoapifyKey: options.geoapifyKey,
      network: !options.offline,
      refresh: options.refresh,
      fetchImpl: options.fetchImpl,
      lookup: options.lookup,
      now: clock,
    },
  );
  report.poi = poi;
  // The POI id is an unverified form field: use the listing only when it is this restaurant.
  let listingFacts: Fact[] = [];
  if (poi.status === 'ok') {
    const check = verifyListing(poi, expectedPlace(state.base.info, submission));
    report.listing = check;
    if (listingDecision && listingDecision.key !== poi.key) {
      report.notes.push(`${RESOLUTIONS_FILE}: the listing decision is about another listing (${listingDecision.key}); ignored`);
    } else if (listingDecision) {
      report.listing = {
        verdict: listingDecision.decision === 'same-place' ? 'verified' : 'rejected',
        reasons: [...check.reasons, `maintainer decision (${RESOLUTIONS_FILE}): ${listingDecision.reason}`],
        decidedBy: 'maintainer',
      };
    }
    if (report.listing.verdict === 'verified') {
      listingFacts = poi.facts;
      if (poi.unmappedCuisines.length) {
        report.notes.push(`map cuisine "${poi.unmappedCuisines.join(';')}" has no cuisine key: decide in ${RESOLUTIONS_FILE} or add a key`);
      }
    } else {
      report.conflicts.push(
        `map listing ${report.listing.verdict.toUpperCase()} (${report.listing.reasons.join('; ')}): ` +
          `its information was not applied` +
          (report.listing.decidedBy
            ? ''
            : `; if it is the same place, record that in ${RESOLUTIONS_FILE} ("listing": { "key": "${poi.key}", "decision": "same-place", "reason": "..." })`),
      );
    }
  }

  // The restaurant (info.json) as it is now (other reviews may have added to
  // it), plus what this submission adds; existing values are never overwritten.
  const info = JSON.parse(await readFile(path.join(target, INFO_FILE), 'utf8')) as Record<string, unknown>;
  const fill = (field: string, value: unknown) => {
    if (value === undefined) return;
    const current = info[field];
    if (current === undefined || (Array.isArray(current) && current.length === 0)) {
      info[field] = value;
      report.filled.push(field);
    } else if (JSON.stringify(current) !== JSON.stringify(value)) {
      report.conflicts.push(`${field}: the record has ${JSON.stringify(current)}, the submission ${JSON.stringify(value)}; not changed`);
    }
  };
  if (!info.address) fill('address', submission.restaurantAddress?.trim() || undefined);
  fill('location', submission.restaurantLocation);
  // Other names the contributor gave: added to altNames (never replacing the name); not used to match restaurants.
  const knownNames = [info.name, ...((info.altNames as string[] | undefined) ?? [])].map((n) => normalizeKeyword(String(n)));
  const newNames = submission.restaurantAltNames.filter((n) => !knownNames.includes(normalizeKeyword(n)));
  if (newNames.length) {
    info.altNames = [...((info.altNames as string[] | undefined) ?? []), ...newNames];
    report.filled.push(`altNames (+${newNames.join(', ')}, from the submission)`);
  }
  // Dishes: the same name (or other name) is the same dish; a new name is a new dish.
  const restaurantDishes = ((info.dishes as { id: string; name: string; altNames?: string[] }[] | undefined) ?? []).slice();
  const dishFor = (name: string) => {
    const key = normalizeKeyword(name);
    const found = restaurantDishes.find((d) => [d.name, ...(d.altNames ?? [])].some((n) => normalizeKeyword(n) === key));
    if (found) return { id: found.id, created: false };
    const taken = new Set(restaurantDishes.map((d) => d.id));
    let n = restaurantDishes.length + 1;
    while (taken.has(`d${n}`)) n++;
    restaurantDishes.push({ id: `d${n}`, name });
    return { id: `d${n}`, created: true };
  };
  const dishes = submission.dishes.map((d, i) => ({
    name: d.name?.trim(),
    verdict: verdictFromAnswer(d.verdictAnswer),
    comment: d.comment?.trim() || undefined,
    images: [...new Set(usable.filter((p) => p.dish === i + 1).map(imageOf).filter((v): v is string => !!v))],
  }));
  const named = dishes.flatMap((d) => (d.name ? [{ ...d, name: d.name, ...dishFor(d.name) }] : []));
  report.dishes = dishes.map((d) => {
    const m = named.find((x) => x.name === d.name);
    return {
      name: d.name,
      verdict: d.verdict,
      comment: !!d.comment,
      images: d.images,
      ...(m ? { dish: m.id, newDish: m.created } : {}),
    };
  });
  if (restaurantDishes.length) info.dishes = restaurantDishes;
  const nameless = dishes.filter((d) => !d.name).flatMap((d) => d.images);
  if (nameless.length) report.notes.push('photos of a dish without a name are kept as the review\'s photos');
  const tagIds = matchedTagIds(report.keywords);
  const currentTags = (info.tags as string[] | undefined) ?? [];
  const addedTags = tagIds.filter((t) => !currentTags.includes(t));
  if (addedTags.length) {
    info.tags = [...currentTags, ...addedTags];
    report.filled.push('tags');
  }
  const pending = report.keywords.filter((k) => k.via === 'pending');
  if (pending.length) {
    report.notes.push(
      `keyword ${pending.map((k) => `"${k.keyword}"`).join(', ')} not in the tag registry: decide in ${RESOLUTIONS_FILE} ` +
        '(an existing tag, a new tag, or skip); until then it is not used',
    );
  }
  // The map listing first, then reviewed decisions; a field set earlier is never replaced.
  const recorded = new Set(Object.keys(state.base.info).map((k) => (k === 'links' ? 'website' : k)));
  report.facts = [
    ...poi.facts
      .filter((f) => !listingFacts.includes(f))
      .map((fact): AppliedFact => ({ fact, applied: false, reason: `the map listing is ${report.listing!.verdict}, not verified` })),
    ...applyFacts(info, [...listingFacts, ...decidedFacts], report.filled, report.conflicts, recorded),
  ];

  // The review: this submission's rating, dishes, photos, and text. An update
  // keeps the earlier review's photos and the dishes it does not mention again.
  const generalPhotos = [
    ...usable.filter((p) => !p.dish).map(imageOf),
    ...nameless,
  ].filter((v): v is string => !!v);
  const submittedDate = /^\d{4}-\d{2}-\d{2}/.exec(submission.submittedAt ?? '')?.[0] ?? clock().slice(0, 10);
  const reviewDishes = [
    ...named.map((d) => ({
      dish: d.id,
      ...(d.verdict !== undefined ? { verdict: d.verdict } : {}),
      ...(d.comment ? { comment: d.comment } : {}),
      ...(d.images.length || previous?.dishes?.find((x) => x.dish === d.id)?.images
        ? { images: [...new Set([...(previous?.dishes?.find((x) => x.dish === d.id)?.images ?? []), ...d.images])] }
        : {}),
    })),
    ...(previous?.dishes ?? []).filter((x) => !named.some((d) => d.id === x.dish)),
  ];
  const general = [...new Set([...(previous?.images ?? []), ...generalPhotos])];
  const review: Review = {
    date: submittedDate,
    ...(report.rating !== undefined
      ? { rating: report.rating as Rating }
      : previous?.rating !== undefined
        ? { rating: previous.rating }
        : {}),
    ...(general.length ? { images: general } : {}),
    ...(reviewDishes.length ? { dishes: reviewDishes } : {}),
  };
  const reviewText = submission.review?.replace(/\r\n?/g, '\n').trim();
  const text = reviewText ? `${reviewText}\n` : state.base.review?.md;

  const parsedInfo = restaurantInfoSchema.safeParse(ordered(info));
  const parsedReview = reviewSchema.safeParse(review);
  if (!parsedInfo.success || !parsedReview.success) {
    for (const [file, result] of [
      [INFO_FILE, parsedInfo],
      [`${REVIEWS_DIR}/${contributorId}.json`, parsedReview],
    ] as const) {
      if (!result.success) report.blockers.push(...result.error.issues.map((i) => `${file}: ${i.path.join('.')}: ${i.message}`));
    }
    return finish('blocked');
  }
  await writeAtomic(path.join(target, INFO_FILE), json(ordered(info)));
  await writeAtomic(reviewFile(target, contributorId, 'json'), json(review));
  if (text !== undefined) await writeAtomic(reviewFile(target, contributorId, 'md'), text);
  else await rm(reviewFile(target, contributorId, 'md'), { force: true });
  await recordDecisions(options.tagFiles, decisions);

  state.written = await own();
  state.writtenInfo = ordered(info);
  state.proposedTags = [...new Set([...state.proposedTags, ...report.newTags])];
  delete state.rejection;
  state.preparedAt = clock();
  await writeAtomic(path.join(dir, PREPARE_STATE_FILE), json(state));
  await updateLog(options.submissionsDir, id, (e) => ({
    ...e!,
    status: 'drafted',
    restaurantId,
    draftWritten: true,
    updatedAt: clock(),
  }));

  await describeDraft(report, target, restaurantId, options);
  const after = `${state.written}|${await readFile(path.join(target, INFO_FILE), 'utf8')}`;
  return finish(after === before ? 'unchanged' : 'drafted');
}

/** The restaurant files as they are now: info.json, the contributor's review, and the image file names. */
async function snapshot(dir: string, contributorId: string): Promise<PrepareState['base']> {
  const info = JSON.parse(await readFile(path.join(dir, INFO_FILE), 'utf8')) as Record<string, unknown>;
  const json = path.join(dir, REVIEWS_DIR, `${contributorId}.json`);
  const md = path.join(dir, REVIEWS_DIR, `${contributorId}.md`);
  return {
    info,
    ...(existsSync(json)
      ? {
          review: {
            json: await readFile(json, 'utf8'),
            ...(existsSync(md) ? { md: await readFile(md, 'utf8') } : {}),
          },
        }
      : {}),
    images: await listImages(dir),
  };
}

/** Fingerprint of a contributor's review files and the photos it imported (detects hand edits). */
async function ownFingerprint(dir: string, contributorId: string, photos: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of [`${REVIEWS_DIR}/${contributorId}.json`, `${REVIEWS_DIR}/${contributorId}.md`, ...[...photos].sort()]) {
    hash.update(`${file}\0`);
    if (existsSync(path.join(dir, file))) hash.update(await readFile(path.join(dir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function fileHash(file: string): Promise<string | undefined> {
  if (!existsSync(file)) return undefined;
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/**
 * What the map listing is compared with: the restaurant's record (an existing
 * restaurant's own name, location, and address are trusted), then the
 * submission's selection.
 */
function expectedPlace(base: Record<string, unknown>, submission: Submission): ExpectedPlace {
  const names = [
    typeof base.name === 'string' ? base.name : undefined,
    ...(Array.isArray(base.altNames) ? (base.altNames as unknown[]) : []),
    submission.restaurantName,
  ].filter((n): n is string => typeof n === 'string' && n.trim() !== '');
  const recorded = base.location as { lat: number; lng: number } | undefined;
  const location = isValidLatLng(recorded) ? recorded : submission.restaurantLocation;
  const address = typeof base.address === 'string' ? base.address : submission.restaurantAddress?.trim() || undefined;
  return { names: [...new Set(names)], ...(location ? { location } : {}), ...(address ? { address } : {}) };
}

/** Adds what would become public, privacy findings, missing fields, and content:check results. */
async function describeDraft(report: PrepareReport, target: string, restaurantId: string, options: PrepareOptions) {
  const info = JSON.parse(await readFile(path.join(target, INFO_FILE), 'utf8')) as RestaurantInfo;
  // The text that becomes public: the restaurant's names and dishes, and this review.
  const cid = report.contributor?.id;
  const read = async (file: string) => (existsSync(file) ? await readFile(file, 'utf8') : '');
  const text = cid ? await read(path.join(target, REVIEWS_DIR, `${cid}.md`)) : '';
  const own = cid ? (JSON.parse((await read(path.join(target, REVIEWS_DIR, `${cid}.json`))) || '{}') as Partial<Review>) : {};
  const texts = [
    text,
    info.name,
    ...(info.altNames ?? []),
    ...(info.dishes ?? []).flatMap((d) => [d.name, ...(d.altNames ?? [])]),
    ...(own.dishes ?? []).map((d) => d.comment ?? ''),
  ];
  report.privacy = [...new Set(texts.flatMap(findContactDetails))];
  const email = report.submission.email?.trim().toLowerCase();
  if (email && texts.some((t) => t.toLowerCase().includes(email))) report.privacy.push("the contributor's contact email");
  report.missing = [
    !info.address && 'address',
    !info.location && 'location (not shown on the map)',
    !info.cuisines?.length && 'cuisines',
    info.pricePerPerson === undefined && 'pricePerPerson',
    !info.links?.website && 'website',
  ].filter((v): v is string => !!v);
  const publicTarget = path.join(options.restaurantsDir, restaurantId);
  if (existsSync(publicTarget)) {
    const changes = await folderChanges(target, publicTarget);
    report.publicChanges = [
      ...changes.added.map((f) => `added    content/restaurants/${restaurantId}/${f}`),
      ...changes.changed.map((f) => `changed  content/restaurants/${restaurantId}/${f}`),
      ...changes.removed.map((f) => `removed  content/restaurants/${restaurantId}/${f}`),
    ];
  } else {
    const files = (await readdir(target, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => path.relative(target, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
      .sort();
    report.publicChanges = files.map((f) => `added    content/restaurants/${restaurantId}/${f}`);
  }
  const registry = await loadTags(options.tagFiles);
  for (const tag of info.tags ?? []) {
    if (!registry.public.some((t) => t.id === tag)) {
      const label = registry.private.proposed.find((t) => t.id === tag)?.label;
      report.publicChanges.push(`added    content/tags.json: "${tag}" (${label ?? '?'})`);
    }
  }
  const contributorsFile = options.contributorFiles.publicFile;
  const publicIds = existsSync(contributorsFile)
    ? (JSON.parse(await readFile(contributorsFile, 'utf8')) as { id: string }[]).map((c) => c.id)
    : [];
  const reviewsDir = path.join(target, REVIEWS_DIR);
  const credited = existsSync(reviewsDir)
    ? (await readdir(reviewsDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    : [];
  for (const c of credited) {
    if (!publicIds.includes(c)) report.publicChanges.push(`added    content/contributors.json: ${c} (display name only)`);
  }
  const result = await runPipeline({
    restaurantsDir: options.restaurantsDir,
    contributorsFile,
    draftsDir: options.draftsDir,
    privateContributorsFile: options.contributorFiles.privateFile,
    tagsFile: options.tagFiles.publicFile,
    privateTagsFile: options.tagFiles.privateFile,
    source: 'content',
    includeDrafts: true,
    base: '/',
    cacheDir: options.imageCacheDir,
  });
  report.diagnostics = result.diagnostics
    .filter((d) => d.restaurantId === restaurantId)
    .map((d) => `${d.draftError ? 'error' : d.level}: ${d.message}`);
}

function photoCounts(state: PhotoState[]): PrepareReport['photos'] {
  return {
    total: state.length,
    imported: 0,
    waived: state.filter((p) => p.status === 'waived').length,
    excluded: state.filter((p) => p.status === 'excluded').length,
    unresolved: state.filter((p) => p.status === 'pending' || p.status === 'failed').map((p) => p.slot),
  };
}

export interface RejectOptions {
  submissionsDir: string;
  draftsDir: string;
  restaurantsDir: string;
  tagFiles: TagFiles;
  /**
   * The maintainer checked the fields reported as edited by both and keeps
   * their current values (recorded in prepare.json).
   */
  resolved?: boolean;
  now?: () => string;
}

export interface RejectResult {
  /** nothing: nothing of it is in a draft; done: taken out; manual: the maintainer must resolve it. */
  status: 'nothing' | 'done' | 'resolved' | 'manual';
  messages: string[];
}

/** Fields that are lists of ids or names: a rejection removes only the entries the submission added. */
const SET_FIELDS = ['tags', 'altNames', 'cuisines'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Takes a rejected submission's review back out of its draft: its review
 * files go (or the contributor's earlier review comes back, for an update)
 * with the photos it brought, and what it added to the restaurant is
 * undone. The raw submission is never touched. For info.json, three-way per
 * field: what the draft had before the submission (base), what prepare
 * wrote, and the draft now. A field prepare changed and nobody edited since
 * goes back to its base value; a field only someone else changed keeps that
 * value; list fields (tags, other names, cuisines) lose only the entries the
 * submission added; a dish it added goes unless another review rates it. A
 * folder prepare created that holds nothing else is removed. When a fact was
 * changed both by prepare and by hand, nothing is changed: the rejection
 * stays "manual" and the draft cannot be promoted until the maintainer edits
 * those fields back or confirms them (resolved).
 *
 * Repeatable: a run that was interrupted is finished by the next one, and a
 * finished rejection does nothing.
 */
export async function rejectSubmission(id: string, options: RejectOptions): Promise<RejectResult> {
  const clock = options.now ?? now;
  const dir = submissionDir(options.submissionsDir, id);
  const state = await readState(dir);
  const messages: string[] = [`the raw submission stays in ${path.basename(options.submissionsDir)}/tally-${id}/ (private)`];
  const logged = (await readLog(options.submissionsDir))[id];
  if (!state && logged?.draftWritten) {
    return { status: 'manual', messages: [...messages, lostStateMessage(id, logged.restaurantId)] };
  }
  if (!state || state.written === undefined) {
    return { status: 'nothing', messages: [...messages, 'nothing of it is in a draft'] };
  }
  const saveState = () => writeAtomic(path.join(dir, PREPARE_STATE_FILE), json(state));
  const finish = async (status: 'done' | 'resolved', details: string[]) => {
    state.rejection = { status, at: clock(), details };
    delete state.written;
    delete state.writtenInfo;
    state.photos = [];
    await saveState();
    await updateLog(options.submissionsDir, id, (e) => ({ ...e!, draftWritten: false }));
    await withdrawProposedTags(state.proposedTags, options);
    messages.push(...details);
    return { status, messages };
  };
  const cid = state.contributorId!;
  const target = path.join(options.draftsDir, state.restaurantId);
  if (!existsSync(path.join(target, INFO_FILE))) {
    if (existsSync(path.join(options.restaurantsDir, state.restaurantId, REVIEWS_DIR, `${cid}.json`))) {
      state.rejection = {
        status: 'manual',
        at: clock(),
        details: [`already promoted to content/restaurants/${state.restaurantId}/: change it there (content:edit) as the maintainer decides`],
      };
      await saveState();
      return { status: 'manual', messages: [...messages, ...state.rejection.details] };
    }
    return finish('done', [`no draft private/drafts/${state.restaurantId}/ any more; nothing to take out`]);
  }
  // Recorded before anything changes: an interrupted rejection still blocks promotion.
  state.rejection = { status: 'pending', at: clock(), details: [] };
  await saveState();

  // The other reviews in the draft (they keep their dishes and photos).
  const reviewsDir = path.join(target, REVIEWS_DIR);
  const others: Review[] = [];
  if (existsSync(reviewsDir)) {
    for (const f of await readdir(reviewsDir)) {
      if (!f.endsWith('.json') || f === `${cid}.json`) continue;
      try {
        others.push(reviewSchema.parse(JSON.parse(await readFile(path.join(reviewsDir, f), 'utf8'))));
      } catch {
        // An invalid review is reported by content:check; it keeps whatever it uses.
      }
    }
  }
  const previous = state.base.review ? reviewSchema.parse(JSON.parse(state.base.review.json)) : undefined;
  const keptReviews = previous ? [...others, previous] : others;
  const rated = new Set(keptReviews.flatMap((r) => (r.dishes ?? []).map((d) => d.dish)));

  const draft = JSON.parse(await readFile(path.join(target, INFO_FILE), 'utf8')) as Record<string, unknown>;
  const written = state.writtenInfo ?? {};
  const base = state.base.info;
  const merged: Record<string, unknown> = {};
  const conflicts: string[] = [];
  type DishEntry = { id: string };
  for (const key of new Set([...Object.keys(draft), ...Object.keys(written), ...Object.keys(base)])) {
    const [d, w, b] = [draft[key], written[key], base[key]];
    if (key === 'dishes') {
      // Dishes this submission added go, unless another review rates them.
      const before = new Set(((b as DishEntry[] | undefined) ?? []).map((x) => x.id));
      const added = new Set(((w as DishEntry[] | undefined) ?? []).map((x) => x.id).filter((x) => !before.has(x)));
      const kept = ((d as DishEntry[] | undefined) ?? []).filter((x) => !added.has(x.id) || rated.has(x.id));
      if (kept.length) merged[key] = kept;
    } else if (SET_FIELDS.includes(key) && (Array.isArray(d) || d === undefined)) {
      const added = new Set(((w as unknown[] | undefined) ?? []).filter((v) => !((b as unknown[] | undefined) ?? []).some((x) => same(x, v))));
      if (d === undefined) continue;
      const kept = (d as unknown[]).filter((v) => ![...added].some((x) => same(x, v)));
      if (kept.length || b !== undefined) merged[key] = kept;
    } else if (same(d, w)) {
      if (b !== undefined) merged[key] = b;
    } else if (same(d, b) || same(w, b)) {
      if (d !== undefined) merged[key] = d;
    } else {
      conflicts.push(`${INFO_FILE} "${key}"`);
      if (d !== undefined) merged[key] = d;
    }
  }

  // Images this submission brought: where it stored them, or a renamed copy
  // (same content) that no other review uses (another review's photo may be
  // the same picture, imported by its own submission).
  const stored = new Set(state.photos.map((m) => m.stored));
  const mapped = new Set(state.photos.map((m) => m.image));
  const usedElsewhere = new Set(keptReviews.flatMap(reviewImages));
  const ownImages: string[] = [];
  for (const image of await listImages(target)) {
    if (state.base.images.includes(image)) continue;
    if (!stored.has((await fileHash(path.join(target, image)))!)) continue;
    if (mapped.has(image) || !usedElsewhere.has(image)) ownImages.push(image);
  }
  const usedImages = ownImages.filter((image) => usedElsewhere.has(image));
  conflicts.push(...usedImages.map((image) => `${image} (used by another review)`));

  if (conflicts.length && !options.resolved) {
    state.rejection = { status: 'manual', at: clock(), details: conflicts };
    await saveState();
    return {
      status: 'manual',
      messages: [
        ...messages,
        `private/drafts/${state.restaurantId}/ was edited by hand where this submission also wrote: ${conflicts.join(', ')}. ` +
          'Nothing was changed; the draft cannot be promoted until you remove the submission\'s content from these ' +
          '(or put back what was there before) and run the rejection again, or confirm the current values with --resolved',
      ],
    };
  }

  const removable = ownImages.filter((image) => !usedImages.includes(image));
  const remaining = (await listImages(target)).filter((image) => !removable.includes(image));
  const details: string[] = [];
  if (
    state.createdDraft &&
    others.length === 0 &&
    !previous &&
    same(ordered(merged), ordered(base)) &&
    same(remaining, state.base.images)
  ) {
    if (state.mode === 'new' || existsSync(path.join(options.restaurantsDir, state.restaurantId, INFO_FILE))) {
      await rm(target, { recursive: true });
      details.push(`removed private/drafts/${state.restaurantId}/, which only held this submission's content`);
      return finish(conflicts.length ? 'resolved' : 'done', details);
    }
  }
  await writeAtomic(path.join(target, INFO_FILE), json(ordered(merged)));
  const own = (ext: 'json' | 'md') => path.join(reviewsDir, `${cid}.${ext}`);
  if (state.base.review) {
    await writeAtomic(own('json'), state.base.review.json);
    if (state.base.review.md !== undefined) await writeAtomic(own('md'), state.base.review.md);
    else await rm(own('md'), { force: true });
  } else {
    await rm(own('json'), { force: true });
    await rm(own('md'), { force: true });
    if (existsSync(reviewsDir) && (await readdir(reviewsDir)).length === 0) await rm(reviewsDir, { recursive: true });
  }
  for (const image of removable) await rm(path.join(target, image), { force: true });
  details.push(
    `took this submission's review out of private/drafts/${state.restaurantId}/` +
      (state.base.review ? ` (${cid}'s earlier review is back)` : '') +
      (removable.length ? ` (removed ${removable.join(', ')})` : '') +
      '; the rest of the draft is unchanged',
  );
  if (conflicts.length) details.push(`kept as confirmed by the maintainer: ${conflicts.join(', ')}`);
  return finish(conflicts.length ? 'resolved' : 'done', details);
}

/** Removes tags a rejected submission proposed, unless a draft or a public restaurant uses them. */
async function withdrawProposedTags(ids: string[], options: RejectOptions) {
  if (ids.length === 0) return;
  const used = new Set<string>();
  for (const root of [options.draftsDir, options.restaurantsDir]) {
    if (!existsSync(root)) continue;
    for (const folder of await readdir(root)) {
      const file = path.join(root, folder, INFO_FILE);
      if (!existsSync(file)) continue;
      try {
        for (const t of (JSON.parse(await readFile(file, 'utf8')) as RestaurantInfo).tags ?? []) used.add(t);
      } catch {
        // Reported by content:check.
      }
    }
  }
  const unused = new Set(ids.filter((t) => !used.has(t)));
  if (unused.size) await withdrawTags(options.tagFiles, unused);
}

/** A rejection that has started and is not finished: pending (interrupted) or manual (needs the maintainer). */
export const unfinishedRejection = (state: PrepareState | undefined) =>
  state?.rejection?.status === 'pending' || state?.rejection?.status === 'manual' ? state.rejection : undefined;

/** What to do when a submission's prepare.json is lost after it wrote a draft. */
function lostStateMessage(id: string, restaurantId?: string, status: LogStatus = 'rejected'): string {
  return (
    `private/submissions/tally-${id}/${PREPARE_STATE_FILE} is missing, but the log shows this submission wrote into ` +
    `the draft ${restaurantId ?? '(unknown)'}, so it cannot be known whether its content is still there. Restore the ` +
    'file from the private backup (docs/submissions.md#retention-and-backup); if there is no backup, check the draft ' +
    'by hand (remove what came from this submission, keep only what has its own source) and confirm with ' +
    `"npm run content:submission -- mark ${id} --status ${status} --state-lost '<what you checked>'"`
  );
}

/**
 * Records a submission's editorial status (content:submission -- mark). The
 * raw submission is kept whatever the status. "rejected" also takes its
 * content out of the draft (rejectSubmission); the rollback state is written
 * before the log, so an interruption still blocks promotion. While a
 * rejection is unfinished (pending or manual), no other status is accepted:
 * the log status never clears that block. --resolved only confirms a
 * rejection.
 */
export async function markOutcome(
  id: string,
  status: LogStatus,
  options: RejectOptions & {
    restaurantId?: string;
    /**
     * Only for lost prepare state: what the maintainer checked in the draft
     * (no content of this submission left, or what stays has its own source).
     * Recorded in the log's audit entries.
     */
    stateLost?: string;
  },
): Promise<RejectResult> {
  for (const [flag, used] of [['--resolved', options.resolved], ['--state-lost', options.stateLost !== undefined]] as const) {
    if (used && status !== 'rejected') throw new IntakeError(`${flag} only confirms a rejection: use it with --status rejected`);
  }
  const entry = (await readLog(options.submissionsDir))[id];
  if (!entry) throw new IntakeError(`submission "${id}" has not been imported`);
  let state: PrepareState | undefined;
  try {
    state = await readState(submissionDir(options.submissionsDir, id));
  } catch (e) {
    throw new IntakeError(
      `private/submissions/tally-${id}/${PREPARE_STATE_FILE} cannot be read (${(e as Error).message.split('\n')[0]}); ` +
        'nothing was changed; restore it from the private backup first',
    );
  }
  // Lost state: the log shows its content went into a draft, but prepare.json is gone.
  const lost = !state && entry.draftWritten === true;
  const note = options.stateLost?.trim();
  if (options.stateLost !== undefined) {
    if (!lost) {
      throw new IntakeError(
        `--state-lost is only for a submission whose ${PREPARE_STATE_FILE} is lost after it wrote a draft; ${id} is not one`,
      );
    }
    if (!note) throw new IntakeError('--state-lost needs a note: what you checked in the draft');
    await updateLog(options.submissionsDir, id, (e) => ({
      ...e!,
      draftWritten: false,
      audit: [
        ...(e!.audit ?? []),
        {
          at: (options.now ?? now)(),
          action: `${PREPARE_STATE_FILE} lost; draft ${e!.restaurantId ?? '?'} checked by the maintainer`,
          note,
        },
      ],
    }));
  } else if (lost) {
    throw new IntakeError(`${lostStateMessage(id, entry.restaurantId, status)}; nothing was changed`);
  }
  const open = unfinishedRejection(state);
  if (status !== 'rejected' && open) {
    throw new IntakeError(
      `the rejection of ${id} is ${open.status === 'manual' ? 'waiting for the maintainer' : 'unfinished'}; nothing was ` +
        `changed. Finish it first with "npm run content:submission -- mark ${id} --status rejected"` +
        (open.status === 'manual' ? ' (add --resolved after checking the reported fields)' : ''),
    );
  }
  const result =
    status === 'rejected' ? await rejectSubmission(id, options) : { status: 'nothing' as const, messages: [] };
  await markSubmission(options.submissionsDir, id, status, options.restaurantId);
  return result;
}

/**
 * Why a draft must not be promoted because of a rejected submission. Decided
 * by the rollback state in each submission's prepare.json, never by the
 * editorial status in the log, which `mark` can change: a rejection that
 * started (pending) or needs the maintainer (manual) blocks until it is
 * finished or resolved with `mark <id> --status rejected [--resolved]`. A
 * submission marked rejected whose content is still in the draft blocks too
 * (the rejection never ran), and so does a prepare.json that cannot be read.
 * Used by content:check and content:promote.
 */
export async function rejectionProblems(submissionsDir: string, restaurantId: string): Promise<string[]> {
  const problems: string[] = [];
  if (!existsSync(submissionsDir)) return problems;
  const log = await readLog(submissionsDir);
  const again = (id: string) => `run "npm run content:submission -- mark ${id} --status rejected"`;
  for (const folder of (await readdir(submissionsDir)).sort()) {
    const id = /^tally-(.+)$/.exec(folder)?.[1];
    if (!id || !existsSync(path.join(submissionsDir, folder, PREPARE_STATE_FILE))) continue;
    let state: PrepareState | undefined;
    try {
      state = await readState(path.join(submissionsDir, folder));
    } catch (e) {
      problems.push(
        `private/submissions/${folder}/${PREPARE_STATE_FILE} cannot be read (${(e as Error).message.split('\n')[0]}), so ` +
          'it is unknown whether a rejected submission\'s content is still in this draft; restore the file from the ' +
          'private backup, then run the command again',
      );
      continue;
    }
    if (state?.restaurantId !== restaurantId) continue;
    const open = unfinishedRejection(state);
    if (open?.status === 'manual') {
      problems.push(
        `submission ${id} was rejected, but its content is still in the draft: edited by hand where it also wrote ` +
          `(${open.details.join(', ')}); remove its content there and ${again(id)} again, or add --resolved after ` +
          'checking those fields',
      );
    } else if (open) {
      problems.push(`submission ${id} was rejected, but its rejection did not finish; ${again(id)} again`);
    } else if (log[id]?.status === 'rejected' && state.written !== undefined) {
      problems.push(`submission ${id} is marked rejected, but its content is still in the draft; ${again(id)}`);
    }
  }
  // Submissions the log shows wrote into this draft, whose prepare.json (or whole folder) is gone.
  for (const [id, entry] of Object.entries(log)) {
    if (entry.restaurantId !== restaurantId || !entry.draftWritten) continue;
    const folder = submissionDir(submissionsDir, id);
    if (existsSync(path.join(folder, PREPARE_STATE_FILE))) continue;
    problems.push(
      `${existsSync(folder) ? '' : `the folder private/submissions/tally-${id}/ is missing; `}` +
        lostStateMessage(id, entry.restaurantId, entry.status),
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Report

const verdictText = (v?: number) => (v === 1 ? '推荐 (1)' : v === -1 ? '避雷 (-1)' : 'none');

/** The review report (Markdown), also written to review-report.md. No contact details or link tokens. */
export function formatPrepareReport(r: PrepareReport, rel: (file: string) => string): string {
  const s = r.submission;
  const outcome: Record<PrepareOutcome, string> = {
    drafted: 'draft prepared (private); waiting for the maintainer',
    unchanged: 'draft already up to date (nothing changed)',
    edited: 'review edited by hand since the last run; left unchanged',
    blocked: 'BLOCKED: nothing was drafted',
    done: 'already done',
  };
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);
  const list = (items: string[], empty = 'none') => (items.length ? items.map((i) => `- ${i}`) : [`- ${empty}`]);
  add(`# Submission ${s.submissionId}`, '');
  add(`- Outcome: **${outcome[r.outcome]}**`);
  if (s.submittedAt) add(`- Submitted: ${s.submittedAt}`);
  add(`- Restaurant match: ${r.identity}`);
  if (r.restaurantId) {
    add(
      `- Restaurant: ${r.restaurantId} (${r.mode === 'new' ? 'new restaurant' : 'existing restaurant'})` +
        (r.draftDir ? `, draft ${rel(r.draftDir)}/` : ''),
    );
  }
  if (r.updatesReview !== undefined) {
    add(`- Review: ${r.updatesReview ? "updates the contributor's earlier review" : 'a new review'}`);
  }
  add(
    `- Contributor: ${r.contributor ? `${r.contributor.id}${r.contributor.created ? ' (new, private until promotion)' : ''}, credited as "${r.contributor.name}"` : 'not resolved'}` +
      `; contact email ${s.email ? 'provided (private)' : 'not provided'}`,
  );
  add(`- Consent: ${r.consent ? 'yes' : 'NO'}`, '');

  add('## Content', '');
  add(`- Rating: ${r.rating ?? 'none'}`);
  add(`- Review text: ${s.review?.trim() ? `${s.review.trim().length} characters` : 'none'}`);
  add(`- Dishes: ${r.dishes.length}`);
  for (const [i, d] of r.dishes.entries()) {
    add(
      `  - ${i + 1}. ${d.name ? `"${d.name}"` : '(no name)'}` +
        (d.dish ? ` -> dish ${d.dish}${d.newDish ? ' (NEW dish; merge it into another if it is the same)' : ''}` : '') +
        `; verdict ${verdictText(d.verdict)}; ` +
        `${d.comment ? 'comment' : 'no comment'}; ${d.images.length ? d.images.join(', ') : 'no photo'}`,
    );
  }
  add(
    `- Photos: ${r.photos.imported} stored of ${r.photos.total} submitted` +
      (r.photos.waived ? `, ${r.photos.waived} waived` : '') +
      (r.photos.excluded ? `, ${r.photos.excluded} beyond the form's limit` : '') +
      (r.photos.unresolved.length ? `, **missing ${r.photos.unresolved.join(', ')}**` : ''),
  );
  if (r.removedImages.length) add(`- Removed images that no longer belong to the submission: ${r.removedImages.join(', ')}`);
  if (r.otherImages.length) {
    add(`- Kept images not from this submission (added by hand; shown in the gallery unless removed): ${r.otherImages.join(', ')}`);
  }
  add('', '## Tags', '');
  if (r.keywords.length === 0) add('- no keywords submitted');
  for (const k of r.keywords) {
    const how =
      k.via === 'pending'
        ? '**pending**: not in the registry; needs a decision'
        : k.via === 'skipped'
          ? `skipped (${k.reason})`
          : `-> ${k.tag} (${k.via === 'registry' ? 'registry' : k.via === 'learned' ? 'learned alias' : k.created ? 'NEW tag, reviewed decision' : 'reviewed decision'})`;
    add(`- "${k.keyword}" ${how}`);
  }
  if (r.newTags.length) add(`- New tags proposed: ${r.newTags.join(', ')} (added to content/tags.json only on promotion)`);

  add('', '## Restaurant information', '');
  if (r.poi) {
    add(`- Map listing lookup: ${r.poi.status}${r.poi.reason ? ` (${r.poi.reason})` : ''}${r.poi.key ? `; listing ${r.poi.key} (private)` : ''}`);
  }
  if (r.listing) {
    add(
      `- Map listing identity: **${r.listing.verdict}**${r.listing.decidedBy ? ' (maintainer decision)' : ''}; ` +
        `${r.listing.reasons.join('; ')}${r.listing.verdict === 'verified' ? '' : '; its information was not applied'}`,
    );
  }
  for (const f of r.facts) {
    add(
      `- ${f.fact.field}: ${JSON.stringify(f.fact.value)}; ${f.fact.source}, ${f.fact.method}, ${f.fact.confidence} confidence; ` +
        `evidence ${f.fact.evidence}; ${f.applied ? 'applied' : `not applied (${f.reason})`}`,
    );
  }
  add(`- Filled in: ${r.filled.length ? r.filled.join(', ') : 'nothing'}`);
  add(`- Still missing: ${r.missing.length ? r.missing.join(', ') : 'nothing'}`);
  add('', '## Conflicts', '', ...list(r.conflicts));
  add('', '## Privacy and consent', '');
  add(...list(r.privacy.map((p) => `possible contact detail in public text: ${p}; remove it before promoting`), 'no contact details found in the public text'));
  add(`- Consent: ${r.consent ? 'given' : 'NOT given: do not prepare or publish'}`);
  add('- Photos are stored without EXIF/XMP/IPTC metadata; check what the photos show (faces, receipts, screens).');
  if (r.blockers.length) add('', '## Blockers', '', ...list(r.blockers));
  add('', '## Notes', '', ...list(r.notes));
  if (r.diagnostics.length) add('', '## content:check', '', ...list(r.diagnostics));
  add('', '## Public files after promotion', '', ...list(r.publicChanges, 'nothing (no draft)'));
  add(
    '',
    'Nothing has been promoted, published, or committed. Promotion (`content:promote -- <id> --approved`) and ' +
      'publication need the maintainer\'s explicit approval.',
    '',
  );
  return lines.join('\n');
}
