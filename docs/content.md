# Content guide

This is the reference for restaurant content: where it lives, the Restaurant
Schema, how photos and reviews are processed, and how drafts become public.
Contributors do not need to read this; they send text and photos and a
maintainer (usually with the `restaurant-intake` Agent Skill) prepares the files.

## Layout and privacy

The GitHub repository is public, and anything committed stays in its history.
Unapproved material therefore never enters Git:

```text
submissions/<id>/        contributors' original files      git-ignored, private
drafts/<id>/             drafts being prepared/reviewed    git-ignored, private
content/restaurants/<id>/ approved restaurants             tracked, public
  info.json              structured data (Restaurant Schema below)
  review.md              optional long-form review in Markdown
  images/                clean photos referenced by info.json or review.md
fixtures/restaurants/    fictional development data        tracked, never deployed
fixtures/submissions/    a fictional submission used by tests
```

There is no index file to maintain: the build discovers every folder.
`npm run check:privacy` (also run in CI) fails if anything under `drafts/` or
`submissions/` is tracked.

## Restaurant Schema (`info.json`)

Only `id`, `status`, and `name` are required for a draft. Unknown fields are
rejected so typos are caught.

| Field            | Type / values                                       | Notes                                                                                                                            |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `lowercase-ascii-with-hyphens`                      | Required. Stable and unique; used in URLs (`/r/<id>/`). Use it as the folder name.                                               |
| `status`         | `"draft"` or `"published"`                          | Required. Only `published` restaurants in `content/restaurants/` are built into the site. Drafts in `drafts/` must stay `draft`. |
| `name`           | string                                              | Required. Display name.                                                                                                          |
| `altNames`       | string[]                                            | Other names (e.g. English or Chinese name). Searchable.                                                                          |
| `summary`        | string, max 160 chars                               | One or two sentences for list and grid views.                                                                                    |
| `cuisines`       | string[]                                            | Used by the cuisine filter, e.g. `["越南菜"]`.                                                                                   |
| `neighborhood`   | string                                              | Used by the area filter, e.g. `"Rice Village"`.                                                                                  |
| `address`        | string                                              |                                                                                                                                  |
| `location`       | `{ "lat": number, "lng": number }`                  | Needed for the map. Must be within 100 km of Rice University.                                                                    |
| `rating`         | integer `1`-`5`                                     | Optional personal rating; see below.                                                                                             |
| `pricePerPerson` | number (USD)                                        | Optional; drives the price filter.                                                                                               |
| `tags`           | string[]                                            | Free-form labels.                                                                                                                |
| `cover`          | path, e.g. `"images/pho.jpg"`                       | Cover photo. A neutral placeholder is shown when absent.                                                                         |
| `coverAlt`       | string                                              | Alt text for the cover; defaults to the name.                                                                                    |
| `dishes`         | `{ name, verdict?, comment?, image?, imageAlt? }[]` | `verdict` is `推荐` or `不推荐`.                                                                                                 |
| `links`          | `{ "googleMaps"?: url, "website"?: url }`           | Without `googleMaps`, a Google Maps search link is derived from the address or coordinates.                                      |
| `contributors`   | `{ name, url? }[]`                                  | Who wrote the text and took the photos. Required to promote or publish.                                                          |

Paths are relative to the restaurant folder and must stay inside it. The zod
definition is `scripts/content/schema.ts`; the generated data shapes the site
reads are in `src/content/model.ts`.

### Ratings

`rating` is a whole number; the data never contains the label. The labels are
defined once, in `RATING_LABELS` in `src/lib/format.ts`, so changing the
wording needs no content changes:

| `rating` | Label  |
| -------- | ------ |
| 5        | 夯     |
| 4        | 顶级   |
| 3        | 人上人 |
| 2        | NPC    |
| 1        | 拉完了 |

Sorting by rating puts 5 first and unrated restaurants last.

Example:

```json
{
  "id": "example-noodles",
  "status": "draft",
  "name": "Example Noodles",
  "cuisines": ["日本菜"],
  "neighborhood": "Rice Village",
  "location": { "lat": 29.7166, "lng": -95.4137 },
  "rating": 4,
  "pricePerPerson": 18,
  "cover": "images/cover.jpg",
  "dishes": [{ "name": "豚骨拉面", "verdict": "推荐", "image": "images/ramen.jpg" }],
  "contributors": [{ "name": "Author Name" }]
}
```

## Reviews (`review.md`)

Ordinary Markdown with GitHub extensions (tables, strikethrough, autolinks).
There is no required structure: write as many paragraphs, headings, and photos
as the review needs.

- Photos: `![alt text](images/photo.jpg "optional caption")`. A photo on its own
  line becomes a figure; the quoted title becomes its caption. Only local
  images are allowed.
- Headings are shifted so the page title stays the only top-level heading.
- Raw HTML, scripts, and unsafe links are removed at build time; links open in
  a new tab.

## Photos

Import photos with `npm run content:add-images`. It never changes the
original and writes a clean copy into the restaurant's `images/` folder:
upright, at most 2400 px, JPEG (PNG only when transparency matters), with all
EXIF, XMP, and IPTC metadata (GPS location, camera, time) removed. HEIC/HEIF is
converted with `sips` on macOS, or `heif-convert` if installed; elsewhere ask
for JPEG copies.

Photos in `content/restaurants/` and `fixtures/` are public, so embedded
metadata there is a blocking error in `content:check`, the build, and
`check:privacy` (detected from the file contents, not the extension). Photos in
`drafts/` are not checked until promotion.

The build then creates WebP renditions 480, 960, and 1600 px wide (never
upscaled, metadata-free), cached in `.cache/images/` by content hash so output
is reproducible.

## From draft to website

1. **Prepare** a private draft: `content:new`, `content:add-images`, edit
   `info.json` and `review.md`, then `content:check -- <id>`. Preview with
   `npm run dev:drafts` (marked 草稿预览). Problems in drafts are warnings and
   never block builds.
2. **Review** the content and the contributor's permission and attribution.
3. **Approve for the public repository**: `npm run content:promote -- <id>`
   lists the files that would become public; with `--approved` it moves the
   folder to `content/restaurants/<id>/`, still `"status": "draft"`. Commit it.
4. **Publish on the website**: `npm run content:publish -- <id> --approved`
   re-validates and sets `"status": "published"`. The site updates when the
   change reaches `main`.

Steps 3 and 4 are maintainer decisions. The `--approved` flag only prevents
accidental runs; the tools cannot verify who approved, and passing validation
is never approval.

Errors in published content fail `npm run build`. After `vite build`,
`scripts/postbuild.ts` checks `dist/` against an allowlist (Vite's build
manifest, `PUBLIC_STATIC_FILES`, and the generated data and WebP images of
published restaurants) and fails on anything else, such as stray files copied
from `public/`, drafts, fixtures, or original photos.

## Commands

| Command                                         | What it does                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `npm run content:new -- <id> --name "<name>"`   | Create a private draft in `drafts/<id>/`.                                |
| `npm run content:add-images -- <id> <files...>` | Import clean photo copies (convert, rotate, strip metadata).             |
| `npm run content:extract -- <file>`             | Print text from `.txt`, `.md`, `.docx`, `.doc`, `.rtf`, `.odt`, `.html`. |
| `npm run content:check [-- <id>...]`            | Validate drafts and public content and list missing information.         |
| `npm run images [-- <id>...]`                   | Process photos and print the renditions.                                 |
| `npm run content:promote -- <id> [--approved]`  | Move an approved draft into the public repository.                       |
| `npm run content:publish -- <id> [--approved]`  | Show a promoted restaurant on the website.                               |
| `npm run content:build`                         | Write site data to `public/generated/` (part of `build`).                |
| `npm run check:privacy`                         | Check tracked files for private folders and image metadata.              |

Add `--source fixtures` to `content:check`, `content:build`, or `images` to
work with the fictional fixtures instead.
