// Command-line entry point for content tasks. Run through npm scripts, e.g.
//   npm run content:check
//   npm run content:new -- my-restaurant --name "My Restaurant"

import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BASE_PATH } from '../../site.config.ts';
import type { ContentSource } from '../../src/content/model.ts';
import { processImage } from './images.ts';
import {
  createDraft,
  extractDocument,
  importImages,
  IntakeError,
  moveDraft,
  setStatus,
} from './intake.ts';
import { IMAGES_DIR, INFO_FILE, runPipeline, type Diagnostic, type PipelineResult } from './pipeline.ts';
import { findSensitiveMetadata, PRIVACY_FIX } from './privacy.ts';
import {
  DRAFTS_DIR,
  IMAGE_CACHE_DIR,
  OUT_DIR,
  RESTAURANT_DIRS,
  ROOT,
  draftsFromEnv,
  sourceFromEnv,
} from './paths.ts';
import { missingInfo, printDiagnostics } from './report.ts';

const USAGE = `Usage: tsx scripts/content/cli.ts <command> [options]

Drafts live in drafts/ (git-ignored, private). Approved restaurants live in
content/restaurants/ (tracked, public repository). Only published restaurants
in content/restaurants/ are built into the website.

Commands:
  new <id> --name <name>
      Create a private draft in drafts/<id>/.
  add-images <id> <file...>
      Copy photos into a restaurant's images/ folder: HEIC converted, rotated
      upright, resized, all metadata (including GPS) removed. Originals untouched.
  extract <file> [--images-out <dir>]
      Print text extracted from a .txt, .md, .docx, .doc, .rtf, .odt, or .html file.
  check [id...] [--source content|fixtures]
      Validate drafts and public content and list missing information.
      Fails on errors in public content or in the given ids.
  images [id...] [--source content|fixtures]
      Process photos and print the generated renditions.
  promote <id> [--approved]
      Move an approved draft from drafts/ into content/restaurants/ (the public
      repository). Without --approved, only lists what would become public.
  publish <id> [--approved]
      Show a promoted restaurant on the website ("status": "published").
      Without --approved, only lists what would be published.
  build [--source content|fixtures] [--drafts]
      Validate content and write website data to public/generated/.
      --drafts also includes drafts (local preview only).

promote and publish cannot verify who approved them: run them only after a
maintainer has explicitly approved that restaurant.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      drafts: { type: 'boolean', default: false },
      approved: { type: 'boolean', default: false },
      name: { type: 'string' },
      'images-out': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const source = (values.source ?? sourceFromEnv()) as ContentSource;
  if (!(source in RESTAURANT_DIRS)) throw new IntakeError(`unknown --source "${source}"`);
  const restaurantsDir = RESTAURANT_DIRS[source];
  // Fixtures have no private drafts directory.
  const draftsDir = source === 'content' ? DRAFTS_DIR : undefined;
  const rel = (file: string) => path.relative(ROOT, file) || '.';
  const validate = (includeDrafts: boolean) =>
    runPipeline({
      restaurantsDir,
      draftsDir,
      source,
      includeDrafts,
      base: BASE_PATH,
      cacheDir: IMAGE_CACHE_DIR,
    });

  switch (command) {
    case 'build': {
      const includeDrafts = values.drafts || draftsFromEnv();
      const result = await runPipeline({
        restaurantsDir,
        // Production builds never read the private drafts directory.
        draftsDir: includeDrafts ? draftsDir : undefined,
        source,
        includeDrafts,
        base: BASE_PATH,
        cacheDir: IMAGE_CACHE_DIR,
        outDir: OUT_DIR,
      });
      printDiagnostics(result.diagnostics);
      if (result.failed) {
        console.error('\nContent build failed. Fix the errors above; nothing was written.');
        return 1;
      }
      const drafts = result.details.filter((d) => d.status === 'draft').length;
      console.log(
        `Content: ${result.details.length} restaurant(s) from ${rel(restaurantsDir)}` +
          (drafts ? ` (${drafts} draft(s) included for local preview)` : '') +
          ` -> ${rel(OUT_DIR)}`,
      );
      return 0;
    }

    case 'check': {
      const result = await validate(true);
      const wanted = new Set(args);
      const relevant = (d: Diagnostic) =>
        wanted.size === 0 || Boolean(d.restaurantId && wanted.has(d.restaurantId));
      printDiagnostics(result.diagnostics.filter(relevant));
      printMissing(result, wanted);
      for (const id of wanted) {
        const known =
          result.restaurants.some((r) => r.info.id === id) ||
          result.diagnostics.some((d) => d.restaurantId === id);
        if (!known) {
          console.error(`error   no restaurant with id "${id}"`);
          return 1;
        }
      }
      const failed = result.diagnostics.some(
        (d) => d.level === 'error' || (d.draftError && wanted.size > 0 && relevant(d)),
      );
      console.log(
        failed
          ? '\nCheck failed.'
          : '\nCheck passed. (Passing validation is not approval to promote or publish.)',
      );
      return failed ? 1 : 0;
    }

    case 'images': {
      let failed = false;
      for (const root of [restaurantsDir, draftsDir]) {
        if (!root || !existsSync(root)) continue;
        const folders = (await readdir(root, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && (args.length === 0 || args.includes(e.name)))
          .map((e) => e.name);
        for (const folder of folders) {
          const imagesDir = path.join(root, folder, IMAGES_DIR);
          if (!existsSync(imagesDir)) continue;
          for (const name of (await readdir(imagesDir)).filter((n) => !n.startsWith('.')).sort()) {
            const file = path.join(imagesDir, name);
            try {
              const image = await processImage(file, IMAGE_CACHE_DIR);
              const sizes = image.renditions
                .map((r) => `${r.width}x${r.height} ${Math.round(r.bytes / 1024)}KB`)
                .join(', ');
              console.log(`ok      ${rel(file)} -> ${sizes}`);
            } catch (e) {
              failed = true;
              console.error(`error   ${rel(file)}: ${(e as Error).message}`);
            }
          }
        }
      }
      return failed ? 1 : 0;
    }

    case 'new': {
      const [id] = args;
      if (!id) throw new IntakeError('usage: content:new -- <id> --name "<name>"');
      if (existsSync(path.join(RESTAURANT_DIRS.content, id))) {
        throw new IntakeError(`content/restaurants/${id} already exists; edit it instead`);
      }
      const dir = await createDraft(DRAFTS_DIR, id, values.name ?? '');
      console.log(`Created private draft ${rel(dir)}/ (${INFO_FILE}, review.md, ${IMAGES_DIR}/)`);
      console.log('drafts/ is git-ignored: nothing here is committed until it is promoted.');
      return 0;
    }

    case 'add-images': {
      const [id, ...files] = args;
      if (!id || files.length === 0) throw new IntakeError('usage: content:add-images -- <id> <file...>');
      const dir = findRestaurantDir(id, restaurantsDir, draftsDir);
      for (const image of await importImages(dir, files.map((f) => path.resolve(f)))) {
        console.log(`added   ${image.source} -> ${rel(image.stored)} (${image.width}x${image.height})`);
      }
      return 0;
    }

    case 'extract': {
      const [file] = args;
      if (!file) throw new IntakeError('usage: content:extract -- <file> [--images-out <dir>]');
      process.stdout.write(await extractDocument(path.resolve(file), values['images-out']));
      return 0;
    }

    case 'promote': {
      const [id] = args;
      if (!id || source !== 'content') throw new IntakeError('usage: content:promote -- <id> [--approved]');
      const dir = path.join(DRAFTS_DIR, id);
      if (!existsSync(path.join(dir, INFO_FILE))) throw new IntakeError(`no private draft at ${rel(dir)}`);
      const problems = await promotionProblems(id, dir, await validate(true));
      if (problems.length > 0) {
        for (const problem of problems) console.error(`error   ${problem}`);
        console.error(`\n${id} was not promoted; it stays private in ${rel(dir)}.`);
        return 1;
      }
      const files = await listFiles(dir);
      console.log(`These files would become public in content/restaurants/${id}/ (and in Git history once committed):`);
      for (const file of files) console.log(`  ${rel(file)}`);
      if (!values.approved) {
        console.log('\nNothing changed. Re-run with --approved only after a maintainer has approved this.');
        return 1;
      }
      const to = await moveDraft(DRAFTS_DIR, RESTAURANT_DIRS.content, id);
      console.log(`\nMoved to ${rel(to)}/. It is still a draft on the website; commit it, then publish when approved.`);
      return 0;
    }

    case 'publish': {
      const [id] = args;
      if (!id) throw new IntakeError('usage: content:publish -- <id> [--approved]');
      const dir = path.join(restaurantsDir, id);
      if (!existsSync(path.join(dir, INFO_FILE))) {
        throw new IntakeError(
          existsSync(path.join(DRAFTS_DIR, id))
            ? `${id} is still a private draft; promote it first (npm run content:promote -- ${id})`
            : `no ${rel(dir)}/${INFO_FILE}`,
        );
      }
      const original = await readFile(path.join(dir, INFO_FILE), 'utf8');
      await setStatus(dir, 'published');
      const result = await validate(false);
      const problems = result.diagnostics.filter((d) => d.restaurantId === id || d.level === 'error');
      if (result.failed || !values.approved) {
        await writeFile(path.join(dir, INFO_FILE), original);
        printDiagnostics(problems);
        if (result.failed) {
          console.error(`\n${id} was not published; it stays a draft.`);
        } else {
          console.log(`${id} passes validation and would appear on the website at /r/${id}/.`);
          console.log('Nothing changed. Re-run with --approved only after a maintainer has approved publication.');
        }
        return 1;
      }
      printDiagnostics(problems);
      console.log(`Published ${id}. Commit the change; the site updates when it reaches main.`);
      return 0;
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

function findRestaurantDir(id: string, restaurantsDir: string, draftsDir?: string): string {
  for (const root of [draftsDir, restaurantsDir]) {
    if (root && existsSync(path.join(root, id, INFO_FILE))) return path.join(root, id);
  }
  throw new IntakeError(`no restaurant folder "${id}"; create the draft first (npm run content:new)`);
}

/** Everything that must hold before a private draft may enter the public repository. */
async function promotionProblems(id: string, dir: string, result: PipelineResult): Promise<string[]> {
  const problems = result.diagnostics
    .filter((d) => d.restaurantId === id && (d.level === 'error' || d.draftError))
    .map((d) => `${d.file}: ${d.message}`);
  const restaurant = result.restaurants.find((r) => r.dir === dir);
  if (restaurant && !restaurant.info.contributors?.length) {
    problems.push(`${INFO_FILE}: add "contributors" (who wrote the text and took the photos) before promoting`);
  }
  if (restaurant && restaurant.info.id !== id) {
    problems.push(`${INFO_FILE}: id "${restaurant.info.id}" must match the folder name "${id}"`);
  }
  for (const file of await listFiles(dir)) {
    try {
      const found = await findSensitiveMetadata(file);
      if (found.length > 0) problems.push(`${path.relative(ROOT, file)}: contains ${found.join(', ')}; ${PRIVACY_FIX}`);
    } catch {
      // Not an image.
    }
  }
  return problems;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

function printMissing(result: PipelineResult, wanted: Set<string>) {
  for (const restaurant of result.restaurants) {
    if (wanted.size > 0 && !wanted.has(restaurant.info.id)) continue;
    const missing = missingInfo(restaurant);
    const where = restaurant.visibility === 'private' ? 'private draft' : restaurant.info.status;
    const label = `${restaurant.info.id} [${where}]`;
    console.log(missing.length ? `missing ${label}: ${missing.join('; ')}` : `ok      ${label}`);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof IntakeError) {
      console.error(`error   ${error.message}`);
      process.exit(1);
    }
    throw error;
  },
);
