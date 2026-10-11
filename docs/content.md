# Content guide

This is the reference for restaurant content: where it lives, the Restaurant
Schema, how photos and reviews are processed, and how publication works.
Contributors do not need to read this; they send text and photos and a
maintainer (usually with the `restaurant-intake` Agent Skill) prepares the files.

## Layout

```text
content/restaurants/
  <folder>/              one folder per restaurant (name it after the id)
    info.json            structured data (Restaurant Schema below)
    review.md            optional long-form review in Markdown
    images/              source photos referenced by info.json or review.md
fixtures/restaurants/    fictional development data (never deployed)
fixtures/submissions/    a fictional contributor submission used by tests
submissions/             raw contributor material (git-ignored, never committed)
```

There is no index file to maintain: the build discovers every folder.

## Restaurant Schema (`info.json`)

Only `id`, `status`, and `name` are required for a draft. Unknown fields are
rejected so typos are caught.

| Field            | Type / values                                       | Notes                                                                                       |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`             | `lowercase-ascii-with-hyphens`                      | Required. Stable and unique; used in URLs (`/r/<id>/`). Do not rename once published.       |
| `status`         | `"draft"` or `"published"`                          | Required. Only `published` restaurants are built into the site.                             |
| `name`           | string                                              | Required. Display name.                                                                     |
| `altNames`       | string[]                                            | Other names (e.g. English or Chinese name). Searchable.                                     |
| `summary`        | string, max 160 chars                               | One or two sentences for list and grid views.                                               |
| `cuisines`       | string[]                                            | Used by the cuisine filter, e.g. `["越南菜"]`.                                              |
| `neighborhood`   | string                                              | Used by the area filter, e.g. `"Rice Village"`.                                             |
| `address`        | string                                              |                                                                                             |
| `location`       | `{ "lat": number, "lng": number }`                  | Needed for the map. Must be within 100 km of Rice University.                               |
| `tier`           | `夯` `顶级` `人上人` `npc` `拉完了`                 | Optional personal rating, best to worst.                                                    |
| `pricePerPerson` | number (USD)                                        | Optional; drives the price filter.                                                          |
| `tags`           | string[]                                            | Free-form labels.                                                                           |
| `cover`          | path, e.g. `"images/pho.jpg"`                       | Cover photo. A neutral placeholder is shown when absent.                                    |
| `coverAlt`       | string                                              | Alt text for the cover; defaults to the name.                                               |
| `dishes`         | `{ name, verdict?, comment?, image?, imageAlt? }[]` | `verdict` is `推荐` or `不推荐`.                                                            |
| `links`          | `{ "googleMaps"?: url, "website"?: url }`           | Without `googleMaps`, a Google Maps search link is derived from the address or coordinates. |
| `contributors`   | `{ name, url? }[]`                                  | Attribution. Required to publish.                                                           |

Paths are relative to the restaurant folder and must stay inside it. The
TypeScript/zod definition is `scripts/content/schema.ts`; the generated data
shapes the site reads are in `src/content/model.ts`.

Example:

```json
{
  "id": "example-noodles",
  "status": "draft",
  "name": "Example Noodles",
  "cuisines": ["日本菜"],
  "neighborhood": "Rice Village",
  "location": { "lat": 29.7166, "lng": -95.4137 },
  "tier": "顶级",
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

Put source photos in `images/` (JPEG, PNG, WebP, or AVIF). The build:

- applies the camera orientation and keeps the aspect ratio;
- creates WebP renditions 480, 960, and 1600 px wide, never upscaling;
- removes all metadata, including GPS location;
- never modifies the source file.

Output is cached in `.cache/images/` by content hash, so it is reproducible and
only new photos are processed. HEIC/HEIF photos must be imported with
`npm run content:add-images` (macOS converts them); that command also strips
metadata from the copy stored in the repository, since the repository is
public. `content:check` warns about committed photos that still carry EXIF.

## Publication

1. New content starts as `"status": "draft"`. Drafts are validated but never
   built into the public site. Problems in drafts are reported as warnings and
   do not block builds.
2. A maintainer reviews the draft (`npm run dev:drafts` previews it with a
   草稿预览 badge).
3. With the contributor's permission and the maintainer's approval,
   `npm run content:publish -- <id>` switches it to `published` after
   re-validating. Any error keeps it a draft.
4. Problems in published content fail `npm run build`, so CI never deploys
   broken content.

After building, `scripts/postbuild.ts` also checks that `dist/` contains no
drafts, fixture data, raw images, or source documents.

## Commands

| Command                                         | What it does                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `npm run content:check [-- <id>...]`            | Validate everything (drafts too) and list missing information.           |
| `npm run content:build`                         | Write site data to `public/generated/` (runs as part of `build`).        |
| `npm run images [-- <id>...]`                   | Process photos and print the renditions.                                 |
| `npm run content:new -- <id> --name "<name>"`   | Create a draft folder.                                                   |
| `npm run content:add-images -- <id> <files...>` | Import photos safely (convert, rotate, strip metadata).                  |
| `npm run content:extract -- <file>`             | Print text from `.txt`, `.md`, `.docx`, `.doc`, `.rtf`, `.odt`, `.html`. |
| `npm run content:publish -- <id>`               | Publish a reviewed draft.                                                |

Add `--source fixtures` to `content:check`, `content:build`, or `images` to
work with the fictional fixtures instead.
