# Rice吃啥 (Rice Eats)

> 项目开发中，尚未正式上线 / Under development, not yet launched

Rice吃啥 是一个面向莱斯大学 (Rice University) 周边地区的社区美食指南和交互式餐厅地图，帮助大家发现休斯顿 Rice 附近值得一去的餐厅。

Rice Eats is a community-maintained restaurant guide and interactive food map for Rice University and the surrounding areas of Houston. The initial version of the site is in Chinese.

Website: https://baoyunfan0101.github.io/rice-eats/

## Features

- **List, grid, and map views** of the same restaurants, with shared search (by name), cuisine, area, and price filters, and sorting by rating, name, or price.
- **Shareable URLs**: the view, filters, and selected restaurant are kept in the address bar, and every restaurant has its own link (`/rice-eats/r/<id>/`).
- **Restaurant pages** with long-form reviews, any number of photos with captions, recommended and not-recommended dishes, and Google Maps navigation links.
- **Responsive** layouts for phones and desktops, keyboard accessible, with loading, empty, and error states.
- **Static**: no backend, database, accounts, or paid services. Hosted on GitHub Pages.
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
- **No router library.** The site has two kinds of pages; a small History API router (`src/lib/router.ts`) keeps the bundle smaller.
- **GitHub Pages deep links.** The build writes `r/<id>/index.html` for each restaurant (served with HTTP 200) and a `404.html` fallback, so direct links and reloads work on static hosting.
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
| `npm run content:check` | Validate all restaurant content                                                                   |
| `npm run images`        | Process restaurant photos and show the results                                                    |
| `npm run build`         | Validate content and build the site into `dist/`                                                  |
| `npm run preview`       | Serve the production build locally                                                                |

The site works with zero published restaurants and shows a "coming soon" state; the fictional fixtures in `fixtures/` are only used for development and tests and are never deployed.

## Content

Each restaurant is a folder under `content/restaurants/` with an `info.json`, an optional `review.md`, and an `images/` folder. There is no index to maintain. See [docs/content.md](docs/content.md) for the schema, Markdown and photo conventions, and the publication workflow.

### Contributing a restaurant

1. Write about the restaurant however you like (plain text, a Word document, notes) and collect your photos.
2. Send them to a maintainer, or give them to a coding agent working in this repository.
3. Review the draft page the maintainer or agent prepares.
4. Approve it for publication. Only then does it appear on the site, credited to you.

### Agent-assisted preparation

Coding agents follow the `restaurant-intake` Agent Skill ([.claude/skills/restaurant-intake/SKILL.md](.claude/skills/restaurant-intake/SKILL.md)), referenced from [AGENTS.md](AGENTS.md). It extracts text from documents, imports and converts photos (including HEIC on macOS) with location metadata removed, writes `info.json` and `review.md` without inventing facts or rewriting opinions, runs validation, and reports what is missing. Content stays a draft until a maintainer runs `npm run content:publish -- <id>`.

## Deployment

Pushes to `main` build and deploy the site with GitHub Actions (`.github/workflows/deploy.yml`); the workflow can also be run manually. Pull requests run lint, type checks, unit tests, end-to-end tests, and a production build (`.github/workflows/ci.yml`).

One-time manual setting: in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.

The site is served from `/rice-eats/`. To build for another path, set `BASE_PATH` (for example `BASE_PATH=/ npm run build`). Map tiles come from OpenStreetMap, whose [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) allows light use with attribution; to use another provider, set `VITE_TILE_URL` and `VITE_TILE_ATTRIBUTION` at build time.

## License

The project source code is licensed under the [MIT License](LICENSE).

Restaurant reviews, photographs, editorial content, and other contributed media are **not** covered by the MIT License. They remain the property of their respective rights holders unless separately licensed, and contributors are credited on each restaurant page. See [LICENSE](LICENSE) for details.

## Disclaimer

Rice吃啥 is an independent community project. It is not affiliated with, endorsed by, or an official service of Rice University.

本项目为独立的社区项目，与莱斯大学无关，亦非莱斯大学官方服务。
