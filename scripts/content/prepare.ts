// Deterministic preparation of a private draft from an imported Tally
// submission (docs/submissions.md, "Prepare a draft"):
//
//   private/submissions/tally-<id>/   raw submission (submission.json, photos)
//     -> resolve the restaurant and the contributor, map keywords to tags,
//        add restaurant information from the map listing, import every photo
//        with its dish
//     -> private/drafts/<restaurant id>/   draft for the maintainer's review
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
// One accepted contributor per restaurant (for now): the first submission
// that is drafted for a restaurant provides its rating, review, dishes,
// photos, and credit. Later submissions about the same restaurant are kept
// unchanged and marked "deferred"; they never change the restaurant.
//
// Re-running is safe: the draft id, the contributor, and the photo -> image
// mapping are stored in prepare.json, so nothing is created twice, and a
// draft edited by hand since the last run is never overwritten (unless
// --rebuild).

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
  tagIdSchema,
  type RestaurantInfo,
} from '../../shared/content/schema.ts';
import { ratingFromAnswer, verdictFromAnswer } from '../../shared/submission.ts';
import { resolveContributor, type ContributorFiles } from './contributors.ts';
import { factSchema, poiDetails, type Fact, type PoiDetails } from './enrich.ts';
import { checkoutRestaurant, createDraft, folderChanges, importImages, newRestaurantId } from './intake.ts';
import { IMAGES_DIR, INFO_FILE, REVIEW_FILE, runPipeline } from './pipeline.ts';
import { findContactDetails } from './privacy.ts';
import {
  loadKnownRestaurants,
  loadPhotoState,
  openSubmission,
  poiIndexFromLog,
  readiness,
  readLog,
  resolveIdentity,
  submissionDir,
  updateLog,
  type Identity,
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
  /** The restaurant before this submission touched it; drafts are rebuilt from it. */
  base: z.strictObject({
    info: z.record(z.string(), z.unknown()),
    review: z.string().optional(),
  }),
  /** True when prepare created the draft folder (new restaurant, or a checkout of a public one). */
  createdDraft: z.boolean(),
  contributorId: contributorIdSchema.optional(),
  /** Submitted photo slot -> stored image, so photos are imported once. */
  photos: z.array(z.strictObject({ slot: z.number().int().min(1), sha256: z.string(), image: z.string() })),
  /** Fingerprint of the draft as prepare last wrote it (detects hand edits). */
  written: z.string().optional(),
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
  /** The draft was edited by hand since the last run; left as it is. */
  | 'edited'
  /** The restaurant already has an accepted contributor; the submission is kept, not used. */
  | 'deferred'
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
  /** True when this submission is (or becomes) the restaurant's accepted contribution. */
  firstContributor?: boolean;
  draftDir?: string;
  contributor?: { id: string; created: boolean; name: string };
  rating?: number;
  dishes: { name?: string; verdict?: number; comment: boolean; images: string[] }[];
  keywords: KeywordMatch[];
  newTags: string[];
  photos: { total: number; imported: number; waived: number; excluded: number; unresolved: number[] };
  poi?: PoiDetails;
  facts: AppliedFact[];
  /** Fields this run filled in (or would). */
  filled: string[];
  conflicts: string[];
  missing: string[];
  privacy: string[];
  consent: boolean;
  blockers: string[];
  notes: string[];
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
  'rating',
  'pricePerPerson',
  'dishes',
  'links',
  'contributorIds',
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
): { decisions: TagDecision[]; facts: Fact[]; problems: string[] } {
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
      if (/[@<>]|https?:/i.test(label)) {
        problems.push(`${RESOLUTIONS_FILE}: label "${label}" may not contain links or "@"; ignored`);
        continue;
      }
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
  return { decisions, facts: parsed.data.facts, problems };
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
      report.notes.push(...checked.problems);
    }
  }
  report.keywords = matchKeywords(submission.keywords, registry, decisions);
  report.newTags = [
    ...new Set(report.keywords.flatMap((k) => (k.via === 'decision' && k.created ? [k.tag] : []))),
  ];

  if (entry.status === 'rejected') report.blockers.push('the submission was marked rejected');
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
  report.identity = describeIdentity(identity);
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

  // A restaurant that was already promoted from this submission's draft.
  const draftDir = (rid: string) => path.join(options.draftsDir, rid);
  const publicDir = (rid: string) => path.join(options.restaurantsDir, rid);
  if (state?.contributorId && !existsSync(draftDir(state.restaurantId))) {
    const promoted = path.join(publicDir(state.restaurantId), INFO_FILE);
    if (existsSync(promoted)) {
      const info = JSON.parse(await readFile(promoted, 'utf8')) as RestaurantInfo;
      if (info.contributorIds?.includes(state.contributorId)) {
        report.notes.push(`the draft was promoted to content/restaurants/${state.restaurantId}/; mark the submission processed`);
        return finish('done');
      }
    }
  }

  // One accepted contributor per restaurant: is the restaurant already taken?
  if (mode === 'existing' && restaurantId) {
    const taken = await acceptedElsewhere(restaurantId, id, state?.contributorId, log, options);
    if (taken) {
      report.firstContributor = false;
      report.notes.push(
        `${taken}. This submission stays saved (raw files and photos) but is not used: one review per restaurant for now`,
      );
      await updateLog(options.submissionsDir, id, (e) => ({ ...e!, status: 'deferred', restaurantId, updatedAt: clock() }));
      return finish('deferred');
    }
  }
  report.firstContributor = true;

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

  if (!state) {
    let base: PrepareState['base'];
    let createdDraft = false;
    if (existsSync(path.join(target, INFO_FILE))) {
      base = await snapshot(target);
    } else if (mode === 'existing') {
      base = await snapshot(publicDir(restaurantId));
      base.info.status = 'draft';
      createdDraft = true;
    } else {
      base = { info: { id: restaurantId, status: 'draft', name: submission.restaurantName!.trim() } };
      createdDraft = true;
    }
    state = { restaurantId, mode: mode!, base, createdDraft, photos: [], preparedAt: clock() };
    await writeAtomic(path.join(dir, PREPARE_STATE_FILE), json(state));
  }

  // Hand edits since the last run are never overwritten (unless --rebuild).
  if (existsSync(path.join(target, INFO_FILE)) && state.written && !options.rebuild) {
    if ((await draftFingerprint(target)) !== state.written) {
      report.notes.push(
        'the draft was edited by hand since the last prepare; nothing was changed (use --rebuild to rebuild it ' +
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
  const before = await draftFingerprint(target);

  // Contributor: found by email, or registered privately.
  if (!state.contributorId) {
    const contributor = await resolveContributor(options.contributorFiles, {
      name: submission.displayName,
      email: validEmail,
    });
    state.contributorId = contributor.id;
    report.contributor = { id: contributor.id, created: contributor.created, name: submission.displayName?.trim() || '匿名' };
    report.notes.push(...contributor.notes);
    await writeAtomic(path.join(dir, PREPARE_STATE_FILE), json(state));
  } else {
    report.contributor = { id: state.contributorId, created: false, name: submission.displayName?.trim() || '匿名' };
  }

  // Photos: every retrieved photo once, in submission order (general photos first,
  // so the cover is a general photo when there is one); each dish keeps its own.
  const images = existsSync(path.join(target, IMAGES_DIR)) ? new Set(await readdir(path.join(target, IMAGES_DIR))) : new Set<string>();
  const usable = photoState.filter((p) => (p.status === 'downloaded' || p.status === 'recovered') && p.file && p.sha256);
  for (const photo of usable) {
    const mapped = state.photos.find((m) => m.slot === photo.slot);
    if (mapped && mapped.sha256 === photo.sha256 && images.has(path.basename(mapped.image))) continue;
    // The same picture uploaded twice is stored once.
    const twin = state.photos.find((m) => m.sha256 === photo.sha256 && images.has(path.basename(m.image)));
    let image = twin?.image;
    if (!image) {
      const [stored] = await importImages(target, [path.join(dir, photo.file!)], [photo.dish ? `dish-${photo.dish}` : 'photo']);
      image = `${IMAGES_DIR}/${path.basename(stored!.stored)}`;
      images.add(path.basename(stored!.stored));
    }
    state.photos = [...state.photos.filter((m) => m.slot !== photo.slot), { slot: photo.slot, sha256: photo.sha256!, image }];
    await writeAtomic(path.join(dir, PREPARE_STATE_FILE), json(state));
  }
  report.photos.imported = new Set(state.photos.map((m) => m.image)).size;
  const imageOf = (p: PhotoState) => state!.photos.find((m) => m.slot === p.slot)?.image;

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
  if (poi.status === 'ok' && poi.name && submission.restaurantName?.trim() &&
      normalizeKeyword(poi.name) !== normalizeKeyword(submission.restaurantName)) {
    report.conflicts.push(`the map listing is named "${poi.name}", the submission "${submission.restaurantName.trim()}"; the submitted name is used`);
  }
  if (poi.unmappedCuisines.length) {
    report.notes.push(`map cuisine "${poi.unmappedCuisines.join(';')}" has no cuisine key: decide in ${RESOLUTIONS_FILE} or add a key`);
  }

  // Build info.json from the base and the submission; existing values are never overwritten.
  const info: Record<string, unknown> = structuredClone(state.base.info);
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
  fill('rating', report.rating);
  const dishes = submission.dishes.map((d, i) => ({
    name: d.name?.trim(),
    verdict: verdictFromAnswer(d.verdictAnswer),
    comment: d.comment?.trim() || undefined,
    images: [...new Set(usable.filter((p) => p.dish === i + 1).map(imageOf).filter((v): v is string => !!v))],
  }));
  report.dishes = dishes.map((d) => ({ name: d.name, verdict: d.verdict, comment: !!d.comment, images: d.images }));
  const named = dishes.filter((d) => d.name);
  if (dishes.some((d) => !d.name && d.images.length)) {
    report.notes.push('photos of a dish without a name are kept as general photos (gallery)');
  }
  fill(
    'dishes',
    named.length
      ? named.map((d) => ({
          name: d.name,
          ...(d.verdict !== undefined ? { verdict: d.verdict } : {}),
          ...(d.comment ? { comment: d.comment } : {}),
          ...(d.images.length ? { images: d.images } : {}),
        }))
      : undefined,
  );
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
  report.facts = applyFacts(info, [...poi.facts, ...decidedFacts], report.filled, report.conflicts, recorded);
  const contributors = (info.contributorIds as string[] | undefined) ?? [];
  if (!contributors.includes(state.contributorId!)) info.contributorIds = [...contributors, state.contributorId!];
  const reviewText = submission.review?.replace(/\r\n?/g, '\n').trim();
  let review = state.base.review;
  if (reviewText) {
    if (!state.base.review?.trim()) {
      review = `${reviewText}\n`;
      report.filled.push(REVIEW_FILE);
    } else if (state.base.review.trim() !== reviewText) {
      report.conflicts.push(`${REVIEW_FILE}: the restaurant already has a review; the submitted text was not added`);
    }
  }

  const parsed = restaurantInfoSchema.safeParse(ordered(info));
  if (!parsed.success) {
    report.blockers.push(...parsed.error.issues.map((i) => `${INFO_FILE}: ${i.path.join('.')}: ${i.message}`));
    return finish('blocked');
  }
  await writeAtomic(path.join(target, INFO_FILE), json(ordered(info)));
  if (review !== undefined) await writeAtomic(path.join(target, REVIEW_FILE), review);
  else await rm(path.join(target, REVIEW_FILE), { force: true });
  await recordDecisions(options.tagFiles, decisions);

  state.written = await draftFingerprint(target);
  state.preparedAt = clock();
  await writeAtomic(path.join(dir, PREPARE_STATE_FILE), json(state));
  await updateLog(options.submissionsDir, id, (e) => ({ ...e!, status: 'drafted', restaurantId, updatedAt: clock() }));

  await describeDraft(report, target, restaurantId, options);
  return finish(state.written === before ? 'unchanged' : 'drafted');
}

/** Restaurant files as they are now (info.json and review.md). */
async function snapshot(dir: string): Promise<PrepareState['base']> {
  const info = JSON.parse(await readFile(path.join(dir, INFO_FILE), 'utf8')) as Record<string, unknown>;
  const reviewFile = path.join(dir, REVIEW_FILE);
  return { info, ...(existsSync(reviewFile) ? { review: await readFile(reviewFile, 'utf8') } : {}) };
}

/**
 * Why the restaurant cannot take this submission's review, or undefined: it
 * already credits a contributor (public), another submission has a draft for
 * it or was processed, or a draft not made from this submission credits
 * someone. Rejected and deferred submissions never block a later one.
 */
async function acceptedElsewhere(
  restaurantId: string,
  self: string,
  ownContributor: string | undefined,
  log: Awaited<ReturnType<typeof readLog>>,
  options: PrepareOptions,
): Promise<string | undefined> {
  for (const [other, e] of Object.entries(log)) {
    if (other !== self && e.restaurantId === restaurantId && (e.status === 'drafted' || e.status === 'processed')) {
      return `restaurant ${restaurantId} already has an accepted submission (${other}, ${e.status})`;
    }
  }
  const credits = async (dir: string) => {
    const file = path.join(dir, INFO_FILE);
    if (!existsSync(file)) return false;
    const info = JSON.parse(await readFile(file, 'utf8')) as RestaurantInfo;
    return (info.contributorIds ?? []).some((c) => c !== ownContributor);
  };
  if (await credits(path.join(options.restaurantsDir, restaurantId))) {
    return `restaurant ${restaurantId} already credits a contributor`;
  }
  const own = await readState(submissionDir(options.submissionsDir, self));
  if (!own && (await credits(path.join(options.draftsDir, restaurantId)))) {
    return `the draft of ${restaurantId} already credits a contributor`;
  }
  return undefined;
}

/** Adds what would become public, privacy findings, missing fields, and content:check results. */
async function describeDraft(report: PrepareReport, target: string, restaurantId: string, options: PrepareOptions) {
  const info = JSON.parse(await readFile(path.join(target, INFO_FILE), 'utf8')) as RestaurantInfo;
  const review = existsSync(path.join(target, REVIEW_FILE)) ? await readFile(path.join(target, REVIEW_FILE), 'utf8') : '';
  const texts = [review, info.name, ...(info.altNames ?? []), ...(info.dishes ?? []).flatMap((d) => [d.name, d.comment ?? ''])];
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
  for (const c of info.contributorIds ?? []) {
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

function describeIdentity(identity: Identity): string {
  switch (identity.kind) {
    case 'existing':
      return `existing restaurant ${identity.restaurant.id} "${identity.restaurant.name}" (id from the restaurant page, name and location agree)`;
    case 'poi-match':
      return `same map listing as ${identity.restaurant.id} "${identity.restaurant.name}" in an earlier reviewed submission (confirm with --id)`;
    case 'conflict':
      return `CONFLICT: id ${identity.restaurant.id} "${identity.restaurant.name}", but ${identity.reason}`;
    case 'unknown-id':
      return `UNKNOWN restaurant id "${identity.id}"`;
    case 'candidates':
      return `possibly an existing restaurant: ${identity.candidates
        .map((c) => `${c.restaurant.id} "${c.restaurant.name}"${c.distance !== undefined ? ` ${Math.round(c.distance)} m away` : ''}${c.nameMatch ? ' (same name)' : ''}`)
        .join(', ')}`;
    case 'new':
      return 'new restaurant (nothing similar by location or name)';
    case 'unidentified':
      return 'unidentified (no id, name, or location)';
  }
}

/**
 * When a submission is rejected, removes the draft prepare made from it if
 * nobody edited it since (a checkout of a public restaurant only discards the
 * unpublished copy). Returns what happened, for the CLI.
 */
export async function discardPreparedDraft(
  submissionsDir: string,
  draftsDir: string,
  id: string,
): Promise<string | undefined> {
  const state = await readState(submissionDir(submissionsDir, id));
  if (!state?.createdDraft) return undefined;
  const target = path.join(draftsDir, state.restaurantId);
  if (!existsSync(target)) return undefined;
  if (!state.written || (await draftFingerprint(target)) !== state.written) {
    return `kept private/drafts/${state.restaurantId}/: it was edited by hand; delete it yourself if it is no longer needed`;
  }
  await rm(target, { recursive: true });
  await writeAtomic(path.join(submissionDir(submissionsDir, id), PREPARE_STATE_FILE), json({ ...state, photos: [], written: undefined }));
  return `removed the unchanged draft private/drafts/${state.restaurantId}/ prepared from this submission`;
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
    edited: 'draft edited by hand since the last run; left unchanged',
    deferred: 'saved, not used: the restaurant already has an accepted contributor',
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
  if (r.firstContributor !== undefined) {
    add(`- First accepted contributor: ${r.firstContributor ? 'yes' : 'no (deferred; the restaurant keeps its current review)'}`);
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
      `  - ${i + 1}. ${d.name ? `"${d.name}"` : '(no name)'}; verdict ${verdictText(d.verdict)}; ` +
        `${d.comment ? 'comment' : 'no comment'}; ${d.images.length ? d.images.join(', ') : 'no photo'}`,
    );
  }
  add(
    `- Photos: ${r.photos.imported} stored of ${r.photos.total} submitted` +
      (r.photos.waived ? `, ${r.photos.waived} waived` : '') +
      (r.photos.excluded ? `, ${r.photos.excluded} beyond the form's limit` : '') +
      (r.photos.unresolved.length ? `, **missing ${r.photos.unresolved.join(', ')}**` : ''),
  );
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
    add(`- Map listing lookup: ${r.poi.status}${r.poi.reason ? ` (${r.poi.reason})` : ''}`);
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
