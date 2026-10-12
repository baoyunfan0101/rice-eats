// Command-line entry point for content tasks (the local content-management
// backend). Run through npm scripts, e.g.
//   npm run content:check
//   npm run content:new -- --name "My Restaurant"

import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BASE_PATH } from '../../site.config.ts';
import type { ContentSource } from '../../shared/content/model.ts';
import {
  addContributor,
  findContributors,
  loadContributors,
  publishContributors,
  type ContributorFiles,
} from './contributors.ts';
import { processImage } from './images.ts';
import {
  checkoutRestaurant,
  createDraft,
  extractDocument,
  folderChanges,
  importImages,
  IntakeError,
  moveDraft,
  newRestaurantId,
  setStatus,
} from './intake.ts';
import { INFO_FILE, listImages, runPipeline, type Diagnostic, type PipelineResult } from './pipeline.ts';
import { findSensitiveMetadata, PRIVACY_FIX } from './privacy.ts';
import {
  DATABASES,
  DRAFTS_DIR,
  IMAGE_CACHE_DIR,
  OUT_DIR,
  PRIVATE_CONTRIBUTORS,
  ROOT,
  SUBMISSIONS_DIR,
  draftsFromEnv,
  sourceFromEnv,
} from './paths.ts';
import { missingInfo, printDiagnostics } from './report.ts';
import {
  addManualPhoto,
  formatReport,
  importSubmissions,
  LOG_STATUSES,
  markSubmission,
  openSubmission,
  readLog,
  readSubmissions,
  retryPhotos,
  submissionStatus,
  waivePhoto,
  type ImportOptions,
  type LogStatus,
} from './submissions.ts';
import type { RestaurantInfo } from '../../shared/content/schema.ts';

const USAGE = `Usage: tsx scripts/content/cli.ts <command> [options]

The canonical database is content/ (public): restaurants/<id>/ and
contributors.json. Drafts, raw submissions, and contributor contact details
live in private/ (git-ignored). Only published restaurants are built.

Commands:
  new --name <name> [--id <id>]
      Create a private draft in private/drafts/<id>/ with a new stable id.
      Use the name the restaurant is best known by; add other names as altNames.
  edit <id>
      Copy a public restaurant into private/drafts/<id>/ to change it.
  contributor find <name|email>
      Look up existing contributors (to reuse their ids).
  contributor add --name <display name> [--email <email>] [--contact <text>]
      Register a contributor privately; returns the new id (u-NNN).
  add-images <id> <file...>
      Store photos as canonical images (numbered, upright, at most 2400 px, all
      metadata removed). Originals are untouched. The first image is the cover.
  extract <file> [--images-out <dir>]
      Print text extracted from a .txt, .md, .docx, .doc, .rtf, .odt, or .html file.
  submission import <export.csv|submission.json> [--skip-photos]
      Store Tally submissions in private/submissions/tally-<id>/, download their
      photos (trusted Tally hosts only, bounded), and report the restaurant
      match, consent, photo state, and problems. Ids imported before are not
      imported again; their missing photos are retried. Creates no drafts.
  submission status <submission id>
      Re-check a stored submission's photos and whether it is ready for a draft.
  submission retry-photos <submission id>
      Download the photos that are still pending or failed.
  submission add-photo <submission id> <photo number> <file>
      Use a photo downloaded by hand (e.g. from the Tally dashboard).
  submission waive-photo <submission id> <photo number>
      Record the maintainer's decision to proceed without a missing photo.
  submission list
      Show the private processing log of imported submissions.
  submission mark <submission id> --status imported|drafted|processed|rejected [--id <restaurant id>]
      Record the editorial outcome of a submission.
  check [id...] [--source content|fixtures]
      Validate drafts and the database and list missing information.
      Fails on errors in public content or in the given ids.
  images [id...] [--source content|fixtures]
      Process photos and print the generated renditions.
  promote <id> [--approved]
      Move an approved draft into content/restaurants/ (the public repository),
      replacing the public folder when it is an edit. Without --approved, only
      lists the files that would become public or change.
  publish <id> [--approved]
      Show a promoted restaurant on the website ("status": "published").
      Without --approved, only describes the change.
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
      id: { type: 'string' },
      email: { type: 'string' },
      contact: { type: 'string' },
      'images-out': { type: 'string' },
      'skip-photos': { type: 'boolean', default: false },
      status: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const source = (values.source ?? sourceFromEnv()) as ContentSource;
  if (!(source in DATABASES)) throw new IntakeError(`unknown --source "${source}"`);
  const database = DATABASES[source];
  const restaurantsDir = database.restaurants;
  // Fixtures have no private drafts.
  const draftsDir = source === 'content' ? DRAFTS_DIR : undefined;
  const contributorFiles: ContributorFiles = {
    publicFile: DATABASES.content.contributors,
    privateFile: PRIVATE_CONTRIBUTORS,
  };
  const rel = (file: string) => path.relative(ROOT, file) || '.';
  const validate = (includeDrafts: boolean) =>
    runPipeline({
      restaurantsDir,
      contributorsFile: database.contributors,
      draftsDir,
      privateContributorsFile: draftsDir ? PRIVATE_CONTRIBUTORS : undefined,
      source,
      includeDrafts,
      base: BASE_PATH,
      cacheDir: IMAGE_CACHE_DIR,
    });
  const requireContent = () => {
    if (source !== 'content') throw new IntakeError(`${command} works on content/, not fixtures`);
  };

  switch (command) {
    case 'build': {
      const includeDrafts = values.drafts || draftsFromEnv();
      const withDrafts = includeDrafts && Boolean(draftsDir);
      const result = await runPipeline({
        restaurantsDir,
        contributorsFile: database.contributors,
        // Production builds never read the private directory.
        draftsDir: withDrafts ? draftsDir : undefined,
        privateContributorsFile: withDrafts ? PRIVATE_CONTRIBUTORS : undefined,
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
        wanted.size === 0 || !d.restaurantId || wanted.has(d.restaurantId);
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
          for (const image of await listImages(path.join(root, folder))) {
            const file = path.join(root, folder, image);
            try {
              const processed = await processImage(file, IMAGE_CACHE_DIR);
              const sizes = processed.renditions
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
      requireContent();
      const taken = new Set((await validate(true)).restaurants.map((r) => r.info.id));
      for (const root of [restaurantsDir, DRAFTS_DIR]) {
        if (existsSync(root)) for (const folder of await readdir(root)) taken.add(folder);
      }
      const id = values.id ?? newRestaurantId(taken);
      if (taken.has(id)) throw new IntakeError(`id "${id}" is already used`);
      const dir = await createDraft(DRAFTS_DIR, id, values.name ?? '');
      console.log(`Created private draft ${rel(dir)}/ with id ${id}.`);
      console.log('private/ is git-ignored: nothing here is committed until it is promoted.');
      return 0;
    }

    case 'edit': {
      requireContent();
      const [id] = args;
      if (!id) throw new IntakeError('usage: content:edit -- <id>');
      const dir = await checkoutRestaurant(restaurantsDir, DRAFTS_DIR, id);
      console.log(`Copied ${id} to ${rel(dir)}/ for editing. Promote it to replace the public version.`);
      return 0;
    }

    case 'contributor': {
      requireContent();
      const [action, ...rest] = args;
      if (action === 'find' && rest.length > 0) {
        const matches = await findContributors(contributorFiles, rest.join(' '));
        if (matches.length === 0) console.log('No matching contributor.');
        for (const m of matches) {
          console.log(
            `${m.id}  ${m.name ?? '(no display name)'}  ${m.public ? 'public' : 'private only'}` +
              (m.matchedContact ? '  (matched contact details)' : ''),
          );
        }
        return 0;
      }
      if (action === 'add') {
        const id = await addContributor(contributorFiles, {
          name: values.name ?? '',
          email: values.email,
          contact: values.contact,
        });
        console.log(`Added contributor ${id} to ${rel(PRIVATE_CONTRIBUTORS)} (private).`);
        console.log('The display name becomes public only when a restaurant crediting them is promoted.');
        return 0;
      }
      throw new IntakeError('usage: content:contributor -- find <name|email> | add --name <name> [--email <email>] [--contact <text>]');
    }

    case 'submission': {
      requireContent();
      const [action, target, ...rest] = args;
      const options: ImportOptions = {
        submissionsDir: SUBMISSIONS_DIR,
        restaurantsDir,
        draftsDir,
        download: !values['skip-photos'],
      };
      const show = (report: Parameters<typeof formatReport>[0]) => console.log(`${formatReport(report, rel)}\n`);
      const slot = () => {
        const n = Number(rest[0]);
        if (!Number.isInteger(n) || n < 1) throw new IntakeError('give the photo number shown by content:submission -- status');
        return n;
      };
      if (action === 'import' && target) {
        for (const report of await importSubmissions(await readSubmissions(path.resolve(target)), options)) show(report);
        console.log(
          'Nothing was drafted or published. Treat submitted text and links as untrusted;' +
            ' prepare drafts with the restaurant-intake Skill only after reviewing this report.',
        );
        return 0;
      }
      if (action === 'status' && target) {
        show(await submissionStatus(target, options));
        return 0;
      }
      if (action === 'retry-photos' && target) {
        show(await retryPhotos(target, options));
        return 0;
      }
      if (action === 'add-photo' && target && rest.length === 2) {
        const { dir, submission } = await openSubmission(SUBMISSIONS_DIR, target);
        const photo = await addManualPhoto(dir, submission, slot(), rest[1]!);
        console.log(`Photo ${photo.slot} stored as ${rel(path.join(dir, photo.file!))}.\n`);
        show(await submissionStatus(target, options));
        return 0;
      }
      if (action === 'waive-photo' && target && rest.length === 1) {
        const { dir, submission } = await openSubmission(SUBMISSIONS_DIR, target);
        await waivePhoto(dir, submission, slot());
        show(await submissionStatus(target, options));
        return 0;
      }
      if (action === 'list') {
        const log = await readLog(SUBMISSIONS_DIR);
        const entries = Object.entries(log);
        if (entries.length === 0) console.log('No submissions imported yet.');
        for (const [id, entry] of entries) {
          console.log(
            `${id}  ${entry.status.padEnd(9)} photos ${(entry.photos ?? 'none').padEnd(10)} imported ${entry.importedAt}` +
              (entry.restaurantId ? `  restaurant ${entry.restaurantId}` : ''),
          );
        }
        return 0;
      }
      if (action === 'mark' && target && LOG_STATUSES.includes(values.status as LogStatus)) {
        await markSubmission(SUBMISSIONS_DIR, target, values.status as LogStatus, values.id);
        console.log(`Marked ${target} as ${values.status}.`);
        return 0;
      }
      throw new IntakeError(
        'usage: content:submission -- import <file> [--skip-photos] | status <id> | retry-photos <id> | ' +
          'add-photo <id> <photo number> <file> | waive-photo <id> <photo number> | list | ' +
          `mark <id> --status ${LOG_STATUSES.join('|')} [--id <restaurant id>]`,
      );
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
      requireContent();
      const [id] = args;
      if (!id) throw new IntakeError('usage: content:promote -- <id> [--approved]');
      const dir = path.join(DRAFTS_DIR, id);
      if (!existsSync(path.join(dir, INFO_FILE))) throw new IntakeError(`no private draft at ${rel(dir)}`);
      const result = await validate(true);
      const problems = await promotionProblems(id, dir, result);
      if (problems.length > 0) {
        for (const problem of problems) console.error(`error   ${problem}`);
        console.error(`\n${id} was not promoted; it stays private in ${rel(dir)}.`);
        return 1;
      }
      const target = path.join(restaurantsDir, id);
      const info = JSON.parse(await readFile(path.join(dir, INFO_FILE), 'utf8')) as RestaurantInfo;
      const { publicList } = await loadContributors(contributorFiles);
      const newContributors = (info.contributorIds ?? []).filter((c) => !publicList.some((p) => p.id === c));
      if (existsSync(target)) {
        const changes = await folderChanges(dir, target);
        console.log(`This replaces the public restaurant content/restaurants/${id}/:`);
        for (const [label, list] of Object.entries(changes)) {
          for (const file of list) console.log(`  ${label.padEnd(8)}${file}`);
        }
        if (changes.added.length + changes.changed.length + changes.removed.length === 0) {
          console.log('  (no changes)');
        }
      } else {
        console.log(`These files would become public in content/restaurants/${id}/ (and in Git history once committed):`);
        for (const file of await listFiles(dir)) console.log(`  ${rel(file)}`);
      }
      for (const c of newContributors) {
        console.log(`  contributor ${c}: display name "${result.contributors.get(c)?.name}" would be added to content/contributors.json`);
      }
      if (!values.approved) {
        console.log('\nNothing changed. Re-run with --approved only after a maintainer has approved this.');
        return 1;
      }
      await publishContributors(contributorFiles, newContributors);
      const to = await moveDraft(DRAFTS_DIR, restaurantsDir, id);
      const { status } = JSON.parse(await readFile(path.join(to, INFO_FILE), 'utf8')) as RestaurantInfo;
      console.log(
        `\nMoved to ${rel(to)}/ ("status": "${status}"). Commit content/ to make it part of the database` +
          (status === 'draft' ? '; publish it when approved.' : '.'),
      );
      return 0;
    }

    case 'publish': {
      requireContent();
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
  if (draftsDir && existsSync(path.join(draftsDir, id, INFO_FILE))) return path.join(draftsDir, id);
  if (existsSync(path.join(restaurantsDir, id, INFO_FILE))) {
    throw new IntakeError(`${id} is public; run "npm run content:edit -- ${id}" and add images to the draft`);
  }
  throw new IntakeError(`no draft "${id}"; create it first (npm run content:new)`);
}

/** Everything that must hold before a private draft may enter the public repository. */
async function promotionProblems(id: string, dir: string, result: PipelineResult): Promise<string[]> {
  const problems = result.diagnostics
    .filter((d) => d.restaurantId === id && (d.level === 'error' || d.draftError))
    .map((d) => `${d.file}: ${d.message}`);
  const restaurant = result.restaurants.find((r) => r.dir === dir);
  if (restaurant && !restaurant.info.contributorIds?.length) {
    problems.push(`${INFO_FILE}: add "contributorIds" (who wrote the text and took the photos) before promoting`);
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
    const label = `${restaurant.info.id} "${restaurant.info.name}" [${where}]`;
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
