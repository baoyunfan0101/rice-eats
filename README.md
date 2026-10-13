# Rice吃啥 (Rice Eats)

> 项目开发中，尚未正式上线 / Under development, not yet launched

Rice吃啥 是一个面向莱斯大学 (Rice University) 周边地区的社区美食指南和交互式餐厅地图，帮助大家发现休斯顿 Rice 附近值得一去的餐厅。

Rice Eats is a community-maintained restaurant guide and interactive food map for Rice University and the surrounding areas of Houston. The initial version of the site is in Chinese.

Website: https://baoyunfan0101.github.io/rice-eats/

## Features

- **List, grid, and map views** of the same restaurants, with shared search (by Chinese, English, or other names), cuisine, scenario tag, rating, and price filters, and sorting by rating, name, or price.
- **Shareable URLs**: the view, filters, and selected restaurant are kept in the address bar, and every restaurant has its own link (`/rice-eats/r/<id>/`).
- **Restaurant pages** with an optional long-form review, any number of photos (photo-only restaurants work too), dishes marked 推荐 or 避雷, and Google Maps and Apple Maps navigation links.
- **Responsive** layouts for phones and desktops, keyboard accessible, with loading, empty, and error states.
- **Static**: no backend, database, accounts, or paid services. Hosted on GitHub Pages.
- **Public submissions**: visitors can send a review, photos, or both through a hosted Tally form (no account needed), from the header or from any restaurant page. Contributing takes two steps: first pick the restaurant on a map that shows nearby restaurants as named pins (from the Geoapify Places API, with a free OpenStreetMap fallback, starting at Rice University), by name search, or by adding it by hand; the selection is confirmed in place on the map. Then fill in the review; the form receives that restaurant as hidden fields. Contributors can list dishes with a verdict and that dish's own photos.
- **Content workflow**: contributors send ordinary text and photos; an Agent Skill turns them into validated drafts, and nothing is published without maintainer review.

## Technology

| Area           | Choice                                                                   |
| -------------- | ------------------------------------------------------------------------ |
| Website        | React, TypeScript, Vite, Tailwind CSS                                    |
| Map            | Leaflet and React Leaflet with OpenStreetMap tiles                       |
| Content        | JSON + Markdown, validated with zod, rendered with unified/remark/rehype |
| Images         | sharp (WebP renditions, orientation fix, metadata removal)               |
| Tests          | Vitest, Testing Library, Playwright                                      |
| Hosting and CI | GitHub Pages, GitHub Actions                                             |

Notable decisions:

- **Build-time content pipeline.** Content is validated and converted once at build time into small JSON files and WebP images, so the browser never parses Markdown or downloads original photos, and broken content fails the build instead of rendering inconsistently.
- **Review HTML is sanitized at build time.** Raw HTML and unsafe links in Markdown are dropped, so editorial content cannot run scripts.
- **Submissions through Tally, not a backend.** The site links to and embeds a hosted Tally form (`/rice-eats/submit/`); Tally stores uploads and emails the maintainers, and local commands turn submissions into private drafts. The form is configured in one place (`TALLY_FORM` in `site.config.ts`); while it is empty, submission links are hidden.
- **No router library.** The site has three kinds of pages; a small History API router (`src/lib/router.ts`) keeps the bundle smaller.
- **GitHub Pages deep links.** The build writes `r/<id>/index.html` for each restaurant and `submit/index.html` (served with HTTP 200) and a `404.html` fallback, so direct links and reloads work on static hosting.
- **The map loads on demand.** Leaflet is downloaded only when the map view is opened.

## Development

Requirements: Node.js 22 or newer (CI uses 24) and npm.

```sh
npm ci                  # install dependencies
npm run dev             # http://localhost:5173/rice-eats/ with real content
npm run dev:fixtures    # same, with fictional sample restaurants
npm run dev:drafts      # real content including drafts (for review)
```

The dev server rebuilds content and reloads the page when anything under the content folder changes.

| Command                 | Purpose                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run lint`          | ESLint and Prettier check (`npm run format` to fix)                                               |
| `npm run typecheck`     | TypeScript                                                                                        |
| `npm test`              | Unit and component tests                                                                          |
| `npm run test:e2e`      | Browser tests against a fixture build served like GitHub Pages (uses the installed Google Chrome) |
| `npm run check:privacy` | Check that no draft, submission, or photo with metadata is tracked by Git                         |
| `npm run content:check` | Validate all restaurant content                                                                   |
| `npm run images`        | Process restaurant photos and show the results                                                    |
| `npm run build`         | Validate content, build the site into `dist/`, and check `dist/` against the allowlist            |
| `npm run preview`       | Serve the production build locally                                                                |

The site works with zero published restaurants and shows a "coming soon" state; the fictional fixtures in `fixtures/` are only used for development and tests and are never deployed.

## Content

The repository holds three independent parts: a file-based **database** (`content/`), local **content-management** commands and an Agent Skill (`scripts/content/`, `.claude/skills/`), and the static **website** (`src/`), which only reads data generated at build time.

Each restaurant is a folder `content/restaurants/<id>/` with `info.json`, an optional `review.md` (one review per restaurant), and standardized photos in `images/`; the first photo is the cover. Restaurant ids are generated and never change, so names may repeat or change. Ratings (1-5), dish verdicts (1 推荐 / -1 避雷), cuisines, and tags are stored as language-independent keys defined in `shared/content/vocabulary.ts`; their display labels live in `src/lib/labels.ts`. Contributors are referenced by id: public names in `content/contributors.json`, contact details only in the git-ignored `private/contributors.json`. The site derives Google Maps and Apple Maps links from each restaurant's coordinates (or, without them, its address). See [docs/content.md](docs/content.md) for the full schema and workflow.

Because this repository is public, raw submissions and drafts stay in the git-ignored `private/` folder until approved. A maintainer approves each restaurant twice: once to add it to the public database (`npm run content:promote -- <id> --approved`) and once to show it on the website (`npm run content:publish -- <id> --approved`). These commands cannot verify who approved them; the flag only prevents accidental runs. Photos are imported with `npm run content:add-images`, which leaves the original untouched and stores a numbered, upright copy without GPS or other metadata.

### Contributing a restaurant

1. Write about the restaurant however you like (a few sentences, a Word document, notes), take photos, or both. Photos alone are fine.
2. Submit them with the "投稿" form on the website, send them to a maintainer, or give them to a coding agent working in this repository.
3. Review the private draft the maintainer or agent prepares, and confirm how you want to be credited.
4. Approve it. Only then is it added to the public repository and shown on the site, credited to you.

### Agent-assisted preparation

Coding agents follow the `restaurant-intake` Agent Skill ([.claude/skills/restaurant-intake/SKILL.md](.claude/skills/restaurant-intake/SKILL.md)), referenced from [AGENTS.md](AGENTS.md). It handles text-only, photo-only, and mixed submissions, updates existing restaurants instead of duplicating them, reuses contributor ids, imports photos (including HEIC on macOS), writes the record without inventing facts or rewriting opinions, runs `npm run content:check`, and reports what is missing. It never commits, promotes, or publishes without the maintainer's explicit approval.

### Public submissions

The website's submission form is hosted by Tally and notifies `hello.riceeats@gmail.com`. Maintainers import submissions with `npm run content:submission -- import <export.csv>`, which stores them in `private/submissions/`, downloads their photos through checked requests to Tally's file hosts, lets missing photos be retried or added by hand, skips duplicates, and reports the restaurant match and consent before the Agent Skill prepares a draft. Form setup, the Gmail workflow, and the end-to-end checklist are in [docs/submissions.md](docs/submissions.md). **Status:** the form is published at https://tally.so/r/obrKlP and configured as `TALLY_FORM` in `site.config.ts`; the live end-to-end checklist has not been run yet.

## Deployment

`.github/workflows/ci.yml` runs on every pull request: lint and formatting, type checks, unit tests, the privacy check, content validation, the production build with its output allowlist, and end-to-end tests. `.github/workflows/deploy.yml` runs on pushes to `main` (and manually): it runs the same CI workflow first and only then builds and deploys to GitHub Pages, so direct pushes cannot skip the checks.

Repository settings this relies on:

- **Settings → Pages → Source: GitHub Actions** (configured).
- **Settings → Rules → Rulesets → "Protect main"**: changes to `main` go through pull requests, the `check` CI job must pass, force pushes and branch deletion are blocked, and nobody can bypass it.

The site is served from `/rice-eats/`. To build for another path, set `BASE_PATH` (for example `BASE_PATH=/ npm run build`). Map tiles come from OpenStreetMap, whose [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) allows light use with attribution; to use another provider, set `VITE_TILE_URL` and `VITE_TILE_ATTRIBUTION` at build time. Nearby restaurant search on the submission page uses the [Geoapify Places API](https://www.geoapify.com/places-api/) with the browser key in `VITE_GEOAPIFY_API_KEY` (in `.env.local` locally, and the `GEOAPIFY_API_KEY` repository variable for GitHub Pages; see [docs/submissions.md](docs/submissions.md)). When there is no key, the credits run out, or Geoapify fails, the page falls back to the free OpenStreetMap Overpass API.

## License

The project source code is licensed under the [MIT License](LICENSE).

Restaurant reviews, photographs, editorial content, and other contributed media are **not** covered by the MIT License. They remain the property of their respective rights holders unless separately licensed, and contributors are credited on each restaurant page. See [LICENSE](LICENSE) for details.

## Disclaimer

Rice吃啥 is an independent community project. It is not affiliated with, endorsed by, or an official service of Rice University.

本项目为独立的社区项目，与莱斯大学无关，亦非莱斯大学官方服务。
