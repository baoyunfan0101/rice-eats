# AGENTS.md

Instructions for coding agents working in this repository.

## Project

Rice吃啥 (Rice Eats) is a community-maintained restaurant guide and interactive food map for Rice University and the surrounding areas of Houston. It is an independent community project, not an official Rice University service.

Architecture: a static single-page site built with React, TypeScript, Vite, Tailwind CSS, and Leaflet, deployed to GitHub Pages. Restaurant content lives in `content/restaurants/<folder>/` as `info.json` plus an optional Markdown `review.md` and photos; a build-time pipeline (`scripts/content/`) validates it, renders reviews to sanitized HTML, converts photos, and writes site data to `public/generated/`. The UI is in Simplified Chinese.

Key paths: `src/` (website), `scripts/content/` (schema, pipeline, image processing, intake tools), `scripts/postbuild.ts` (build output allowlist), `docs/content.md` (schema and content conventions), `fixtures/` (fictional test data), `tests/` (unit and end-to-end tests).

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

The repository is public, so Git history is public. Content moves through three stages:

1. Raw submissions in `submissions/` and drafts in `drafts/`: git-ignored, private to the maintainer's computer.
2. Approved for the repository: `npm run content:promote -- <id> --approved` moves a draft to `content/restaurants/<id>/` with `"status": "draft"`; it is public once committed but not on the website.
3. Published: `npm run content:publish -- <id> --approved` sets `"status": "published"`; the website shows it after it reaches `main`.

Rules:

- Use the `restaurant-intake` Agent Skill (`.claude/skills/restaurant-intake/SKILL.md`) whenever someone provides restaurant text, documents, or photos to add or update. Use its commands (`content:new`, `content:add-images`, `content:extract`, `content:check`) instead of doing conversions by hand.
- Never commit, promote, or publish without the maintainer's explicit approval for that restaurant and step. Passing `content:check` is not approval. The `--approved` flag cannot verify who approved; it only prevents accidental runs.
- Never commit anything under `drafts/` or `submissions/`. Import photos with `content:add-images`; tracked images with EXIF/XMP/IPTC metadata (e.g. GPS) fail `content:check`, `npm run check:privacy`, and CI.
- Preserve existing content and user-authored reviews; never invent restaurant information, ratings, reviews, or photos; do not silently overwrite or delete user-provided content.
- Ratings are stored as numbers 1-5 (`"rating"`); labels are defined only in `src/lib/format.ts`.
- Contributor rights: record who wrote the text and took the photos in `contributors`; promotion and publication require it.
- Fixtures in `fixtures/` are fictional and must stay clearly labeled; never move them into `content/`.

## Licensing

Source code is MIT-licensed. Restaurant reviews, photographs, editorial content, and other contributed media are excluded from the MIT License. Keep code and editorial content licensing separate, and do not relicense content. Credit contributors in `contributors`.
