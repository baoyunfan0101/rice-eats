// Command-line entry point for content tasks. Run through npm scripts, e.g.
//   npm run content:check
//   npm run content:new -- my-restaurant --name "My Restaurant"

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BASE_PATH } from '../../site.config.ts';
import type { ContentSource } from '../../src/content/model.ts';
import { processImage } from './images.ts';
import { createDraft, extractDocument, importImages, IntakeError, setStatus } from './intake.ts';
import {
  IMAGES_DIR,
  INFO_FILE,
  runPipeline,
  type Diagnostic,
  type PipelineResult,
} from './pipeline.ts';
import { IMAGE_CACHE_DIR, OUT_DIR, RESTAURANT_DIRS, ROOT, draftsFromEnv, sourceFromEnv } from './paths.ts';
import { missingInfo, printDiagnostics } from './report.ts';

const USAGE = `Usage: tsx scripts/content/cli.ts <command> [options]

Commands:
  build [--source content|fixtures] [--drafts]
      Validate content and write website data to public/generated/.
  check [id...] [--source content|fixtures]
      Validate everything (drafts included) and list missing information.
      Fails on errors in published content or in the given ids.
  images [id...] [--source content|fixtures]
      Process photos and print the generated renditions.
  new <id> --name <name>
      Create a draft restaurant folder in content/restaurants/.
  add-images <id> <file...>
      Copy photos into a restaurant's images/ folder (HEIC converted, metadata stripped).
  extract <file> [--images-out <dir>]
      Print text extracted from a .txt, .md, .docx, .doc, .rtf, .odt, or .html file.
  publish <id>
      Mark a draft as published after it passes validation. Only after maintainer approval.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      drafts: { type: 'boolean', default: false },
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
  const rel = (file: string) => path.relative(ROOT, file);

  switch (command) {
    case 'build': {
      const includeDrafts = values.drafts || draftsFromEnv();
      const result = await runPipeline({
        restaurantsDir,
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
          (drafts ? ` (${drafts} draft(s) included for preview)` : '') +
          ` -> ${rel(OUT_DIR)}`,
      );
      return 0;
    }

    case 'check': {
      const result = await runPipeline({
        restaurantsDir,
        source,
        includeDrafts: true,
        base: BASE_PATH,
        cacheDir: IMAGE_CACHE_DIR,
      });
      const wanted = new Set(args);
      const relevant = (d: Diagnostic) => wanted.size === 0 || (d.restaurantId && wanted.has(d.restaurantId));
      printDiagnostics(result.diagnostics.filter(relevant));
      printMissing(result, wanted);
      const failed = result.diagnostics.some(
        (d) => d.level === 'error' || (d.draftError && wanted.size > 0 && relevant(d)),
      );
      for (const id of wanted) {
        if (!result.restaurants.some((r) => r.info.id === id)) {
          const invalid = result.diagnostics.some((d) => d.restaurantId === id);
          if (!invalid) {
            console.error(`error   no restaurant with id "${id}" in ${rel(restaurantsDir)}`);
            return 1;
          }
        }
      }
      console.log(failed ? '\nCheck failed.' : '\nCheck passed.');
      return failed ? 1 : 0;
    }

    case 'images': {
      const folders = (await readdir(restaurantsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && (args.length === 0 || args.includes(e.name)))
        .map((e) => e.name);
      let failed = false;
      for (const folder of folders) {
        const imagesDir = path.join(restaurantsDir, folder, IMAGES_DIR);
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
      return failed ? 1 : 0;
    }

    case 'new': {
      const [id] = args;
      if (!id) throw new IntakeError('usage: content:new -- <id> --name "<name>"');
      const dir = await createDraft(RESTAURANT_DIRS.content, id, values.name ?? '');
      console.log(`Created draft ${rel(dir)}/ (${INFO_FILE}, review.md, ${IMAGES_DIR}/)`);
      return 0;
    }

    case 'add-images': {
      const [id, ...files] = args;
      if (!id || files.length === 0) throw new IntakeError('usage: content:add-images -- <id> <file...>');
      const dir = path.join(restaurantsDir, id);
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

    case 'publish': {
      const [id] = args;
      if (!id) throw new IntakeError('usage: content:publish -- <id>');
      const dir = path.join(restaurantsDir, id);
      if (!existsSync(path.join(dir, INFO_FILE))) throw new IntakeError(`no ${rel(dir)}/${INFO_FILE}`);
      const original = await setStatus(dir, 'published');
      const result = await runPipeline({
        restaurantsDir,
        source,
        includeDrafts: false,
        base: BASE_PATH,
        cacheDir: IMAGE_CACHE_DIR,
      });
      const problems = result.diagnostics.filter((d) => d.restaurantId === id || d.level === 'error');
      if (result.failed) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path.join(dir, INFO_FILE), original);
        printDiagnostics(problems);
        console.error(`\n${id} was not published; it stays a draft.`);
        return 1;
      }
      printDiagnostics(problems);
      console.log(`Published ${id}. Commit the change to make it live.`);
      return 0;
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

function printMissing(result: PipelineResult, wanted: Set<string>) {
  for (const restaurant of result.restaurants) {
    if (wanted.size > 0 && !wanted.has(restaurant.info.id)) continue;
    const missing = missingInfo(restaurant);
    const label = `${restaurant.info.id} [${restaurant.info.status}]`;
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
