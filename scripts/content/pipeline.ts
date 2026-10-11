// Content pipeline: discover restaurant folders, validate them, render reviews,
// process images, and write website-ready data under public/generated/.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  distanceKm,
  RICE_CENTER,
  type ContentIndex,
  type ContentSource,
  type Dish,
  type ImageAsset,
  type RestaurantDetail,
  type RestaurantSummary,
} from '../../src/content/model.ts';
import { checkImageExtension, copyRenditions, processImage, type ProcessedImage } from './images.ts';
import { findSensitiveMetadata, PRIVACY_FIX } from './privacy.ts';
import { listMarkdownImages, renderMarkdown } from './markdown.ts';
import { formatIssues, restaurantInfoSchema, type RestaurantInfo } from './schema.ts';

export const INFO_FILE = 'info.json';
export const REVIEW_FILE = 'review.md';
export const IMAGES_DIR = 'images';
/** Restaurants farther than this from Rice are almost certainly typos or swapped lat/lng. */
export const MAX_DISTANCE_KM = 100;

export interface PipelineOptions {
  /**
   * Publicly tracked restaurants (content/restaurants or fixtures/restaurants):
   * one subfolder per restaurant. Images here must be free of metadata.
   */
  restaurantsDir: string;
  /**
   * Private, git-ignored drafts (drafts/). Read only for checks and draft
   * previews; production builds never pass it.
   */
  draftsDir?: string;
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
  /** Path relative to the repository root (or as given). */
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
}

export interface PipelineResult {
  diagnostics: Diagnostic[];
  /** Restaurants that passed validation, drafts included. */
  restaurants: LoadedRestaurant[];
  index: ContentIndex;
  details: RestaurantDetail[];
  /** True when there are errors that block the build. */
  failed: boolean;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const diagnostics: Diagnostic[] = [];
  const display = (file: string) => path.relative(process.cwd(), file) || file;

  // 1. Discover and parse.
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
          message: `skipped: no ${INFO_FILE} (run "npm run content:new -- <id>" to create a draft)`,
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
      const statusHint =
        raw && typeof raw === 'object' && 'status' in raw ? String(raw.status) : undefined;
      const idHint = raw && typeof raw === 'object' && 'id' in raw ? String(raw.id) : undefined;
      if (!parsed.success) {
        for (const message of formatIssues(parsed.error)) {
          diagnostics.push({
            level: 'error',
            file: display(infoPath),
            message,
            restaurantId: idHint,
            draft: isPrivate || statusHint === 'draft',
          });
        }
        continue;
      }
      const reviewPath = path.join(dir, REVIEW_FILE);
      const review = existsSync(reviewPath) ? await readFile(reviewPath, 'utf8') : undefined;
      loaded.push({ folder, dir, visibility, info: parsed.data, review });
    }
  }

  // 2. Cross-restaurant checks.
  const byId = new Map<string, LoadedRestaurant[]>();
  for (const restaurant of loaded) {
    const list = byId.get(restaurant.info.id) ?? [];
    list.push(restaurant);
    byId.set(restaurant.info.id, list);
  }
  const invalid = new Set<LoadedRestaurant>();
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
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

  // 3. Per-restaurant checks: coordinates, asset references, contributors.
  for (const restaurant of loaded) {
    const { info, dir } = restaurant;
    const infoFile = display(path.join(dir, INFO_FILE));
    const draft = isDraft(restaurant);
    const error = (message: string, file = infoFile, blocking = false) => {
      invalid.add(restaurant);
      diagnostics.push({ level: 'error', file, message, restaurantId: info.id, draft: draft && !blocking });
    };

    if (restaurant.visibility === 'private' && info.status !== 'draft') {
      error(
        'private drafts must keep "status": "draft"; after approval, move it into the public ' +
          'repository with "npm run content:promote -- <id>" and then publish it',
      );
    }
    const warn = (message: string, file = infoFile) =>
      diagnostics.push({ level: 'warning', file, message, restaurantId: info.id });

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
    if (info.status === 'published' && !info.contributors?.length) {
      error('published restaurants need at least one entry in "contributors" (attribution)');
    }

    const references: { ref: string; field: string; file: string }[] = [];
    if (info.cover) references.push({ ref: info.cover, field: 'cover', file: infoFile });
    info.dishes?.forEach((dish, i) => {
      if (dish.image) references.push({ ref: dish.image, field: `dishes.${i}.image`, file: infoFile });
    });
    if (restaurant.review !== undefined) {
      const reviewFile = display(path.join(dir, REVIEW_FILE));
      for (const image of listMarkdownImages(restaurant.review)) {
        if (/^[a-z]+:/i.test(image.url) || image.url.startsWith('//')) {
          error(`image "${image.url}" must be a local file in ${IMAGES_DIR}/, not a URL`, reviewFile);
          continue;
        }
        references.push({ ref: image.url, field: 'image', file: reviewFile });
        if (!image.alt.trim()) warn(`image "${image.url}" has no alt text`, reviewFile);
      }
    }
    const realDir = await realpath(dir);
    for (const { ref, field, file } of references) {
      const target = path.resolve(dir, ref);
      if (!existsSync(target) || !(await stat(target)).isFile()) {
        error(`${field}: file "${ref}" does not exist`, file);
        continue;
      }
      const realTarget = await realpath(target);
      if (!realTarget.startsWith(realDir + path.sep)) {
        error(`${field}: "${ref}" is outside the restaurant folder`, file);
        continue;
      }
      try {
        checkImageExtension(target);
      } catch (e) {
        error(`${field}: "${ref}": ${(e as Error).message}`, file);
      }
    }

    // Unreferenced photos are fine in drafts but usually mean something was forgotten.
    const imagesDir = path.join(dir, IMAGES_DIR);
    const imageFiles = existsSync(imagesDir)
      ? (await readdir(imagesDir)).filter((name) => !name.startsWith('.')).sort()
      : [];
    const used = new Set(references.map((r) => path.resolve(dir, r.ref)));
    for (const name of imageFiles) {
      if (!used.has(path.resolve(imagesDir, name))) {
        warn(`${IMAGES_DIR}/${name} is not used by ${INFO_FILE} or ${REVIEW_FILE}`);
      }
    }

    // Everything in a public folder is in the public repository, published or
    // not, so embedded metadata (e.g. GPS) is a blocking error there.
    if (restaurant.visibility === 'public') {
      for (const name of imageFiles) {
        const file = path.join(imagesDir, name);
        let problems: string[];
        try {
          problems = await findSensitiveMetadata(file);
        } catch {
          continue; // Unreadable or non-image files are reported when referenced.
        }
        if (problems.length > 0) {
          error(`contains ${problems.join(', ')}; ${PRIVACY_FIX}`, display(file), true);
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
    options.includeDrafts || (r.visibility === 'public' && r.info.status === 'published');
  const failed = diagnostics.some((d) => d.level === 'error');

  // 4. Render included restaurants.
  const included = valid.filter(isIncluded);
  const details: RestaurantDetail[] = [];
  const processed = new Map<string, ProcessedImage>();
  if (!failed) {
    for (const restaurant of included) {
      try {
        details.push(await renderRestaurant(restaurant, options, processed));
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
  details.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const index: ContentIndex = {
    source: options.source,
    includesDrafts: options.includeDrafts,
    restaurants: details.map(toSummary),
  };
  const finalFailed = diagnostics.some((d) => d.level === 'error');

  // 5. Write output (only when everything succeeded).
  if (options.outDir && !finalFailed) {
    await rm(options.outDir, { recursive: true, force: true });
    await mkdir(path.join(options.outDir, 'restaurants'), { recursive: true });
    for (const [key, image] of processed) {
      await copyRenditions(image, path.join(options.outDir, 'images', key.split('\0')[0]!));
    }
    for (const detail of details) {
      await writeFile(
        path.join(options.outDir, 'restaurants', `${detail.id}.json`),
        JSON.stringify(detail),
      );
    }
    await writeFile(path.join(options.outDir, 'index.json'), JSON.stringify(index));
  }

  return { diagnostics, restaurants: valid, index, details, failed: finalFailed };
}

/** Drafts (private, or public but unpublished) never block builds. */
function isDraft(r: LoadedRestaurant): boolean {
  return r.visibility === 'private' || r.info.status === 'draft';
}

async function renderRestaurant(
  restaurant: LoadedRestaurant,
  options: PipelineOptions,
  processed: Map<string, ProcessedImage>,
): Promise<RestaurantDetail> {
  const { info, dir } = restaurant;
  const assets = new Map<string, ImageAsset>();

  const asset = async (ref: string, alt: string): Promise<ImageAsset> => {
    const source = path.resolve(dir, ref);
    const key = `${info.id}\0${source}`;
    let image = processed.get(key);
    if (!image) {
      try {
        image = await processImage(source, options.cacheDir);
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

  const cover = info.cover ? await asset(info.cover, info.coverAlt ?? info.name) : undefined;
  const dishes: Dish[] = [];
  for (const dish of info.dishes ?? []) {
    dishes.push({
      name: dish.name,
      verdict: dish.verdict,
      comment: dish.comment,
      image: dish.image ? await asset(dish.image, dish.imageAlt ?? dish.name) : undefined,
    });
  }
  let reviewHtml = '';
  if (restaurant.review?.trim()) {
    for (const image of listMarkdownImages(restaurant.review)) {
      assets.set(image.url, await asset(image.url, image.alt));
    }
    reviewHtml = await renderMarkdown(restaurant.review, (url) => {
      const found = assets.get(url);
      if (!found) throw new Error(`${REVIEW_FILE}: unresolved image "${url}"`);
      return found;
    });
  }

  return {
    id: info.id,
    status: info.status,
    name: info.name,
    altNames: info.altNames ?? [],
    summary: info.summary,
    cuisines: info.cuisines ?? [],
    neighborhood: info.neighborhood,
    address: info.address,
    location: info.location,
    rating: info.rating,
    pricePerPerson: info.pricePerPerson,
    tags: info.tags ?? [],
    cover,
    mapsUrl: mapsUrl(info),
    website: info.links?.website,
    dishes,
    reviewHtml,
    contributors: info.contributors ?? [],
  };
}

function mapsUrl(info: RestaurantInfo): string | undefined {
  if (info.links?.googleMaps) return info.links.googleMaps;
  const query = info.address
    ? `${info.name}, ${info.address}`
    : info.location
      ? `${info.location.lat},${info.location.lng}`
      : undefined;
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : undefined;
}

function toSummary(detail: RestaurantDetail): RestaurantSummary {
  return {
    id: detail.id,
    status: detail.status,
    name: detail.name,
    altNames: detail.altNames,
    summary: detail.summary,
    cuisines: detail.cuisines,
    neighborhood: detail.neighborhood,
    address: detail.address,
    location: detail.location,
    rating: detail.rating,
    pricePerPerson: detail.pricePerPerson,
    tags: detail.tags,
    cover: detail.cover,
    mapsUrl: detail.mapsUrl,
  };
}
