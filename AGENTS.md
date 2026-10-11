# AGENTS.md

Instructions for coding agents working in this repository.

## Project

Rice吃啥 (Rice Eats) is a food guide and interactive restaurant map for the area around Rice University in Houston. It is an independent community project, not an official Rice University service.

Architecture: a static single-page site built with React, TypeScript, Vite, Tailwind CSS, and Leaflet, deployed to GitHub Pages. Restaurant content lives in `content/restaurants/<folder>/` as `info.json` plus an optional Markdown `review.md` and photos; a build-time pipeline (`scripts/content/`) validates it, renders reviews to sanitized HTML, converts photos, and writes site data to `public/generated/`. The UI is in Simplified Chinese.

Key paths: `src/` (website), `scripts/content/` (schema, pipeline, image processing, intake tools), `docs/content.md` (schema and content conventions), `fixtures/` (fictional test data), `tests/` (unit and end-to-end tests).

## Principles

- Prefer simple, maintainable, static-first solutions.
- Follow established project conventions (`.editorconfig`, `.gitattributes`, existing code style).
- Keep changes focused on the assigned task.
- Do not add dependencies or backend infrastructure without a concrete need.
- The project has not launched: do not add version numbers, releases, changelogs, schema versions, or backward-compatibility code. When a structure changes, update the code, content, and tests directly.

## Commands

- `npm ci` install, `npm run dev` develop (`dev:fixtures` with fictional data, `dev:drafts` with drafts)
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` (uses the local Google Chrome)
- `npm run build` then `npm run preview`
- `npm run content:check` validates all content

Run lint, typecheck, unit tests, and build before handing work back.

## Content

- Preserve existing content and user-authored reviews.
- Never invent restaurant information, ratings, reviews, or photos.
- Do not silently overwrite or delete user-provided content; ask first.
- To add or update a restaurant from contributor material (text, documents, photos), follow the `restaurant-intake` Agent Skill in `.claude/skills/restaurant-intake/SKILL.md`. Use its deterministic commands (`content:new`, `content:add-images`, `content:extract`, `content:check`) rather than doing conversions by hand.
- New content is always a draft. Only run `npm run content:publish -- <id>` after a maintainer explicitly approves that restaurant, with the contributor's permission and attribution recorded in `contributors`.
- Never commit raw submissions (`submissions/` is ignored) or photos with location metadata; import photos with `content:add-images`.
- Fixtures in `fixtures/` are fictional and must stay clearly labeled as such; never move them into `content/`.

## Licensing

Source code is MIT-licensed. Restaurant reviews, photographs, editorial content, and other contributed media are excluded from the MIT License. Keep code and editorial content licensing separate, and do not relicense content. Credit contributors in `contributors`.
