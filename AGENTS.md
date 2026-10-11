# AGENTS.md

Instructions for coding agents working in this repository.

## Project

Rice吃啥 (Rice Eats) is a community-maintained restaurant guide and interactive food map for Rice University and the surrounding areas of Houston. It is an independent community project, not an official Rice University service.

Architecture, three independent layers in one repository:

- Database (`content/`): the canonical, file-based source of truth. `content/restaurants/<id>/` holds `info.json`, an optional `review.md` (one review per restaurant), and standardized photos in `images/`; `content/contributors.json` holds public contributor names.
- Content management (`scripts/content/`, `.claude/skills/`): local commands and the Agent Skill that turn submissions into database records, validate them, and handle approval. Private work happens in the git-ignored `private/`.
- Frontend (`src/`): a static React site (Vite, Tailwind CSS, Leaflet) on GitHub Pages. It reads data generated at build time into `public/generated/` and never writes to the database. The UI is in Simplified Chinese.

Key paths: `src/` (website), `src/content/taxonomy.ts` (cuisine, tag, rating, and verdict keys with their display labels), `scripts/content/` (schema, pipeline, image processing, intake tools), `scripts/postbuild.ts` (build output allowlist), `docs/content.md` (schema and content conventions), `fixtures/` (fictional test data), `tests/` (unit and end-to-end tests).

## Principles

- Prefer simple, maintainable, static-first solutions.
- Follow established project conventions (`.editorconfig`, `.gitattributes`, existing code style).
- Keep changes focused on the assigned task.
- Do not add dependencies or backend infrastructure without a concrete need.
- The project has not launched: do not add version numbers, releases, changelogs, schema versions, or backward-compatibility code. When a structure changes, update the code, content, and tests directly.

## Commands

- `npm ci` install, `npm run dev` develop (`dev:fixtures` with fictional data, `dev:drafts` with drafts)
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` (uses the local Google Chrome)
- `npm run check:privacy` checks tracked files for private folders and image metadata
- `npm run build` (validates content and the build output) then `npm run preview`
- `npm run content:check` validates drafts and public content

Run lint, typecheck, unit tests, `check:privacy`, and build before handing work back. `main` only accepts pull requests whose CI passes.

## Content

The repository is public, so Git history is public. Unapproved material stays in the git-ignored `private/` folder: raw submissions (`private/submissions/`), drafts (`private/drafts/<id>/`), and contributor contact details (`private/contributors.json`).

1. Draft: `npm run content:new -- --name "<name>"` (new) or `npm run content:edit -- <id>` (existing) creates a private draft.
2. Approved for the repository: `npm run content:promote -- <id> --approved` moves it into `content/restaurants/<id>/` and adds new contributors' display names to `content/contributors.json`.
3. Published: `npm run content:publish -- <id> --approved` sets `"status": "published"`; the website shows it after it reaches `main`.

Rules:

- Use the `restaurant-intake` Agent Skill (`.claude/skills/restaurant-intake/SKILL.md`) whenever someone provides restaurant text, documents, or photos (including photos only) to add or update. Use its commands (`content:new`, `content:edit`, `content:contributor`, `content:add-images`, `content:extract`, `content:check`) instead of doing conversions by hand.
- Never commit, promote, or publish without the maintainer's explicit approval for that restaurant and step. Passing `content:check` is not approval. The `--approved` flag cannot verify who approved; it only prevents accidental runs.
- Never commit anything under `private/`. The database holds only standardized photos imported with `content:add-images` (numbered, at most 2400 px, no metadata); anything else fails `content:check`, `npm run check:privacy`, and CI.
- One restaurant has one record and one review. Update the existing record instead of creating a second one; ids are generated, unique, and never change.
- Never invent restaurant information, ratings, verdicts, tags, reviews, or photos; every field except `id`, `status`, and `name` is optional and stays out when not supplied. Do not silently overwrite or delete contributor content.
- Store keys, not display text: `rating` 1-5, dish `verdict` 1 or -1 (absent means no opinion), and `cuisines`/`tags` keys from `src/content/taxonomy.ts`, which is the only place labels are defined.
- Contributors are referenced by id (`contributorIds`); public names live in `content/contributors.json`, contact details only in `private/contributors.json`.
- Fixtures in `fixtures/` are fictional and must stay clearly labeled; never move them into `content/`.

## Licensing

Source code is MIT-licensed. Restaurant reviews, photographs, editorial content, and other contributed media are excluded from the MIT License. Keep code and editorial content licensing separate, and do not relicense content. Credit contributors through `contributorIds`.
