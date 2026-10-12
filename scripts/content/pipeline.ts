// Content pipeline: read the canonical database (restaurant folders and the
// contributor list), validate it, render reviews, process images, and write
// website-ready data under public/generated/. The database is only read.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  distanceKm,
  RICE_CENTER,
  type ContentIndex,
  type ContentSource,
  type Contributor,
  type Dish,
  type ImageAsset,
  type RestaurantDetail,
  type RestaurantSummary,
} from '../../shared/content/model.ts';
import { canonicalImageProblems, copyRenditions, processImage, type ProcessedImage } from './images.ts';
import { listMarkdownImages, renderMarkdown } from './markdown.ts';
import { findSensitiveMetadata, PRIVACY_FIX } from './privacy.ts';
import {
  displayName,
  formatIssues,
  privateContributorsSchema,
  publicContributorsSchema,
  restaurantInfoSchema,
  type RestaurantInfo,
} from '../../shared/content/schema.ts';

export const INFO_FILE = 'info.json';
export const REVIEW_FILE = 'review.md';
export const IMAGES_DIR = 'images';
/** Restaurants farther than this from Rice are almost certainly typos or swapped lat/lng. */
export const MAX_DISTANCE_KM = 100;

export interface PipelineOptions {
  /**
   * Publicly tracked restaurants (content/restaurants or fixtures/restaurants):
   * one folder per restaurant, named after its id.
   */
  restaurantsDir: string;
  /** Public contributor list (content/contributors.json). May be missing when there are none. */
  contributorsFile: string;
  /**
   * Private, git-ignored drafts (private/drafts). Read only for checks and
   * draft previews; production builds never pass it.
   */
  draftsDir?: string;
  /** Private contributor file (private/contributors.json); read together with draftsDir. */
  privateContributorsFile?: string;
  source: ContentSource;
  /** Include drafts in the output (local preview only). */
  includeDrafts: boolean;
  /** Public base path, e.g. "/rice-eats/". */
  base: string;
  cacheDir: string;
  /** Output folder (public/generated). Omit to validate without writing. */
  outDir?: string;
}

export interface Diagnostic {
  level: 'error' | 'warning';
  /** Path relative to the working directory. */
  file: string;
  message: string;
  restaurantId?: string;
  /** Set when the problem belongs to a draft; such problems are reported as warnings. */
  draft?: boolean;
  /** An error in a draft, downgraded to a warning so it does not block builds. */
  draftError?: boolean;
}

export interface LoadedRestaurant {
  folder: string;
  dir: string;
  /** "public": tracked in Git. "private": a local, git-ignored draft. */
  visibility: 'public' | 'private';
  info: RestaurantInfo;
  review?: string;
  /** Image paths relative to the folder ("images/01-x.jpg"), in display order. */
  images: string[];
}

export interface PipelineResult {
  diagnostics: Diagnostic[];
  /** Restaurants that passed validation, drafts included. */
  restaurants: LoadedRestaurant[];
  /** Contributors known to this run (public, plus pending private ones when drafts are read). */
  contributors: Map<string, Contributor>;
  index: ContentIndex;
  details: RestaurantDetail[];
  /** True when there are errors that block the build. */
  failed: boolean;
}

/** Display order of images: by their numeric prefix, then name. */
export const compareImageNames = (a: string, b: string) =>
  a.localeCompare(b, 'en', { numeric: true });

export async function listImages(dir: string): Promise<string[]> {
  const imagesDir = path.join(dir, IMAGES_DIR);
  if (!existsSync(imagesDir)) return [];
  return (await readdir(imagesDir))
    .filter((name) => !name.startsWith('.'))
    .sort(compareImageNames)
    .map((name) => `${IMAGES_DIR}/${name}`);
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const diagnostics: Diagnostic[] = [];
  const display = (file: string) => path.relative(process.cwd(), file) || file;

  // 1. Contributors.
  const contributors = new Map<string, Contributor>();
  const publicContributorIds = new Set<string>();
  if (existsSync(options.contributorsFile)) {
    const parsed = await readJson(options.contributorsFile, publicContributorsSchema, diagnostics, display);
    for (const c of parsed ?? []) {
      contributors.set(c.id, c);
      publicContributorIds.add(c.id);
    }
  }
  if (options.draftsDir && options.privateContributorsFile && existsSync(options.privateContributorsFile)) {
    const parsed = await readJson(options.privateContributorsFile, privateContributorsSchema, diagnostics, display);
    for (const [id, record] of Object.entries(parsed ?? {})) {
      if (!contributors.has(id) && record.name) contributors.set(id, { id, name: record.name });
    }
  }

  // 2. Discover and parse restaurants.
  const loaded: LoadedRestaurant[] = [];
  const roots: [string, LoadedRestaurant['visibility']][] = [[options.restaurantsDir, 'public']];
  if (options.draftsDir) roots.push([options.draftsDir, 'private']);
  for (const [root, visibility] of roots) {
    const folders = existsSync(root)
      ? (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => entry.name)
          .sort()
      : [];
    for (const folder of folders) {
      const dir = path.join(root, folder);
      const infoPath = path.join(dir, INFO_FILE);
      const isPrivate = visibility === 'private';
      if (!existsSync(infoPath)) {
        diagnostics.push({
          level: 'warning',
          file: display(dir),
          message: `skipped: no ${INFO_FILE} (run "npm run content:new -- --name <name>" to create a draft)`,
        });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(infoPath, 'utf8'));
      } catch (error) {
        diagnostics.push({
          level: 'error',
          file: display(infoPath),
          message: `invalid JSON: ${(error as Error).message}`,
          draft: isPrivate,
        });
        continue;
      }
      const parsed = restaurantInfoSchema.safeParse(raw);
      const hint = (key: string) =>
        raw && typeof raw === 'object' && key in raw ? String((raw as Record<string, unknown>)[key]) : undefined;
      if (!parsed.success) {
        for (const message of formatIssues(parsed.error)) {
          diagnostics.push({
            level: 'error',
            file: display(infoPath),
            message,
            restaurantId: hint('id'),
            draft: isPrivate || hint('status') === 'draft',
          });
        }
        continue;
      }
      const reviewPath = path.join(dir, REVIEW_FILE);
      const review = existsSync(reviewPath) ? await readFile(reviewPath, 'utf8') : undefined;
      loaded.push({ folder, dir, visibility, info: parsed.data, review, images: await listImages(dir) });
    }
  }

  // 3. Duplicate ids (names may repeat; ids may not). A private draft with the
  // id of a public restaurant is an edit of it (content:edit), not a duplicate;
  // in draft previews the draft replaces the public version.
  const invalid = new Set<LoadedRestaurant>();
  const shadowed = new Set<LoadedRestaurant>();
  const byId = new Map<string, LoadedRestaurant[]>();
  for (const restaurant of loaded) {
    byId.set(restaurant.info.id, [...(byId.get(restaurant.info.id) ?? []), restaurant]);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    const isEdit =
      list.length === 2 && list.some((r) => r.visibility === 'public') && list.some((r) => r.visibility === 'private');
    if (isEdit) {
      shadowed.add(list.find((r) => r.visibility === 'public')!);
      continue;
    }
    for (const restaurant of list) {
      invalid.add(restaurant);
      diagnostics.push({
        level: 'error',
        file: display(path.join(restaurant.dir, INFO_FILE)),
        message: `duplicate id "${id}" (also used by ${list
          .filter((other) => other !== restaurant)
          .map((other) => display(other.dir))
          .join(', ')})`,
        restaurantId: id,
        draft: isDraft(restaurant),
      });
    }
  }

  // 4. Per-restaurant checks.
  for (const restaurant of loaded) {
    const { info, dir } = restaurant;
    const isPublic = restaurant.visibility === 'public';
    const infoFile = display(path.join(dir, INFO_FILE));
    const draft = isDraft(restaurant);
    // `blocking` errors are about files in the public repository and are never downgraded.
    const error = (message: string, file = infoFile, blocking = false) => {
      invalid.add(restaurant);
      diagnostics.push({ level: 'error', file, message, restaurantId: info.id, draft: draft && !blocking });
    };
    const warn = (message: string, file = infoFile) =>
      diagnostics.push({ level: 'warning', file, message, restaurantId: info.id });

    if (restaurant.folder !== info.id) {
      error(`folder name "${restaurant.folder}" must equal the id "${info.id}"`);
    }
    if (!isPublic && info.status !== 'draft') {
      error(
        'private drafts must keep "status": "draft"; after approval, move it into the public ' +
          'repository with "npm run content:promote -- <id>" and then publish it',
      );
    }
    if (info.location) {
      const km = distanceKm(info.location, RICE_CENTER);
      if (km > MAX_DISTANCE_KM) {
        const swapped = distanceKm({ lat: info.location.lng, lng: info.location.lat }, RICE_CENTER);
        error(
          `location is ${Math.round(km)} km from Rice University` +
            (swapped <= MAX_DISTANCE_KM ? '; lat and lng look swapped' : '; check the coordinates'),
        );
      }
    }

    // Contributors are referenced by id; public restaurants may only use public ids.
    for (const id of info.contributorIds ?? []) {
      if (!contributors.has(id)) {
        error(`contributorIds: "${id}" is not a known contributor (add it with "npm run content:contributor")`);
      } else if (isPublic && !publicContributorIds.has(id)) {
        error(`contributorIds: "${id}" is not in the public contributor list; promote the restaurant to add it`);
      }
    }
    if (info.status === 'published' && !info.contributorIds?.length) {
      error('published restaurants need at least one entry in "contributorIds" (attribution)');
    }

    // Only info.json, review.md, and images/ belong in a restaurant folder.
    for (const entry of await readdir(dir)) {
      if (entry.startsWith('.') || [INFO_FILE, REVIEW_FILE, IMAGES_DIR].includes(entry)) continue;
      const message = `unexpected file "${entry}"; a restaurant folder holds only ${INFO_FILE}, ${REVIEW_FILE}, and ${IMAGES_DIR}/`;
      if (isPublic) error(message, display(path.join(dir, entry)), true);
      else warn(message, display(path.join(dir, entry)));
    }

    // Images: canonical files, and (in the public repository) no embedded metadata.
    for (const image of restaurant.images) {
      const file = path.join(dir, image);
      if (!(await stat(file)).isFile()) {
        error(`${image} is not a file`, display(file), isPublic);
        continue;
      }
      const problems = await canonicalImageProblems(file);
      if (problems.length > 0) {
        error(`not a standardized image: ${problems.join('; ')}; ${PRIVACY_FIX}`, display(file), isPublic);
        continue;
      }
      if (isPublic) {
        const metadata = await findSensitiveMetadata(file);
        if (metadata.length > 0) error(`contains ${metadata.join(', ')}; ${PRIVACY_FIX}`, display(file), true);
      }
    }

    // References from dishes and review.md must point at stored images.
    const known = new Set(restaurant.images);
    info.dishes?.forEach((dish, i) => {
      if (dish.image && !known.has(dish.image)) error(`dishes.${i}.image: "${dish.image}" is not in ${IMAGES_DIR}/`);
    });
    if (restaurant.review !== undefined) {
      const reviewFile = display(path.join(dir, REVIEW_FILE));
      for (const image of listMarkdownImages(restaurant.review)) {
        if (/^[a-z]+:/i.test(image.url) || image.url.startsWith('//')) {
          error(`image "${image.url}" must be a local file in ${IMAGES_DIR}/, not a URL`, reviewFile);
        } else if (!known.has(image.url)) {
          error(`image "${image.url}" is not in ${IMAGES_DIR}/`, reviewFile);
        } else if (!image.alt.trim()) {
          warn(`image "${image.url}" has no alt text`, reviewFile);
        }
      }
    }
  }

  // Problems in drafts never block a build: drafts are not published, and an
  // invalid draft is simply left out (also in draft previews).
  for (const d of diagnostics) {
    if (d.level === 'error' && d.draft) {
      d.level = 'warning';
      d.draftError = true;
    }
  }
  const valid = loaded.filter((r) => !invalid.has(r));
  const isIncluded = (r: LoadedRestaurant) =>
    options.includeDrafts
      ? !shadowed.has(r)
      : r.visibility === 'public' && r.info.status === 'published';
  const failed = diagnostics.some((d) => d.level === 'error');

  // 5. Render included restaurants.
  const details: RestaurantDetail[] = [];
  const processed = new Map<string, ProcessedImage>();
  if (!failed) {
    for (const restaurant of valid.filter(isIncluded)) {
      try {
        details.push(await renderRestaurant(restaurant, contributors, options, processed));
      } catch (e) {
        const draft = isDraft(restaurant);
        diagnostics.push({
          level: draft ? 'warning' : 'error',
          file: display(restaurant.dir),
          message: (e as Error).message,
          restaurantId: restaurant.info.id,
          draft,
          draftError: draft,
        });
      }
    }
  }
  details.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id));
  const index: ContentIndex = {
    source: options.source,
    includesDrafts: options.includeDrafts,
    restaurants: details.map(toSummary),
  };
  const finalFailed = diagnostics.some((d) => d.level === 'error');

  // 6. Write output (only when everything succeeded).
  if (options.outDir && !finalFailed) {
    await rm(options.outDir, { recursive: true, force: true });
    await mkdir(path.join(options.outDir, 'restaurants'), { recursive: true });
    for (const [key, image] of processed) {
      await copyRenditions(image, path.join(options.outDir, 'images', key.split('\0')[0]!));
    }
    for (const detail of details) {
      await writeFile(path.join(options.outDir, 'restaurants', `${detail.id}.json`), JSON.stringify(detail));
    }
    await writeFile(path.join(options.outDir, 'index.json'), JSON.stringify(index));
  }

  return { diagnostics, restaurants: valid, contributors, index, details, failed: finalFailed };
}

async function readJson<T>(
  file: string,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: import('zod').ZodError } },
  diagnostics: Diagnostic[],
  display: (file: string) => string,
): Promise<T | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    diagnostics.push({ level: 'error', file: display(file), message: `invalid JSON: ${(error as Error).message}` });
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const message of formatIssues(parsed.error)) diagnostics.push({ level: 'error', file: display(file), message });
    return undefined;
  }
  return parsed.data;
}

/** Drafts (private, or public but unpublished) never block builds. */
function isDraft(r: LoadedRestaurant): boolean {
  return r.visibility === 'private' || r.info.status === 'draft';
}

async function renderRestaurant(
  restaurant: LoadedRestaurant,
  contributors: Map<string, Contributor>,
  options: PipelineOptions,
  processed: Map<string, ProcessedImage>,
): Promise<RestaurantDetail> {
  const { info, dir } = restaurant;

  const asset = async (ref: string, alt: string): Promise<ImageAsset> => {
    const key = `${info.id}\0${ref}`;
    let image = processed.get(key);
    if (!image) {
      try {
        image = await processImage(path.join(dir, ref), options.cacheDir);
      } catch (e) {
        throw new Error(`${ref}: ${(e as Error).message}`, { cause: e });
      }
      processed.set(key, image);
    }
    const url = (fileName: string) => `${options.base}generated/images/${info.id}/${fileName}`;
    const mid = [...image.renditions].reverse().find((r) => r.width <= 960) ?? image.renditions[0]!;
    return {
      src: url(mid.fileName),
      srcset: image.renditions.map((r) => `${url(r.fileName)} ${r.width}w`).join(', '),
      width: image.width,
      height: image.height,
      alt,
    };
  };

  // Alt text: the restaurant name for the cover, the dish name or review alt text
  // where an image is used, otherwise the name with the photo's position.
  const reviewImages = restaurant.review?.trim() ? listMarkdownImages(restaurant.review) : [];
  const name = displayName(info);
  const altFor = (ref: string, i: number) =>
    i === 0
      ? name
      : (info.dishes?.find((d) => d.image === ref)?.name ??
        reviewImages.find((img) => img.url === ref && img.alt.trim())?.alt ??
        `${name} (${i + 1})`);
  const images: ImageAsset[] = [];
  for (const [i, ref] of restaurant.images.entries()) images.push(await asset(ref, altFor(ref, i)));
  const byRef = new Map(restaurant.images.map((ref, i) => [ref, images[i]!]));
  const indexOf = (ref: string) => restaurant.images.indexOf(ref);

  // Placement is recorded as indexes into `images`, so the website can decide
  // where each photo appears without inspecting HTML.
  const dishes: Dish[] = (info.dishes ?? []).map((dish) => ({
    name: dish.name,
    verdict: dish.verdict,
    comment: dish.comment,
    imageIndex: dish.image ? indexOf(dish.image) : undefined,
  }));
  const reviewImageIndexes = [...new Set(reviewImages.map((img) => indexOf(img.url)))].filter((i) => i >= 0);

  const reviewHtml = restaurant.review?.trim()
    ? await renderMarkdown(restaurant.review, (url) => {
        const found = byRef.get(url);
        if (!found) throw new Error(`${REVIEW_FILE}: unresolved image "${url}"`);
        return found;
      })
    : '';

  return {
    id: info.id,
    status: info.status,
    name,
    nameZh: info.nameZh,
    nameEn: info.nameEn,
    altNames: info.altNames ?? [],
    cuisines: info.cuisines ?? [],
    tags: info.tags ?? [],
    address: info.address,
    location: info.location,
    rating: info.rating,
    pricePerPerson: info.pricePerPerson,
    cover: images[0],
    links: { ...info.links },
    images,
    dishes,
    reviewHtml,
    reviewImageIndexes,
    contributors: (info.contributorIds ?? []).map((id) => contributors.get(id)!),
  };
}

function toSummary(detail: RestaurantDetail): RestaurantSummary {
  return {
    id: detail.id,
    status: detail.status,
    name: detail.name,
    nameZh: detail.nameZh,
    nameEn: detail.nameEn,
    altNames: detail.altNames,
    cuisines: detail.cuisines,
    tags: detail.tags,
    address: detail.address,
    location: detail.location,
    rating: detail.rating,
    pricePerPerson: detail.pricePerPerson,
    cover: detail.cover,
    links: detail.links,
  };
}
