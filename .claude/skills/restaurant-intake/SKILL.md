---
name: restaurant-intake
description: Turn a contributor's restaurant submission (free-form text, Markdown, Word documents, photos in JPEG/PNG/WebP/HEIC, or any mix, including photos only) into a standardized, validated Rice Eats record in a private draft, or update an existing restaurant, then report what is missing for maintainer review. Use whenever someone provides restaurant notes, a review, or food photos. Never commits, promotes, or publishes anything without explicit maintainer approval.
---

# Restaurant content intake

Contributors send whatever they have: a few sentences, a long review, a Word
document, photos, or only photos. Turn it into the canonical database format
without inventing anything, keep it private, and hand it to a maintainer. The
schema and conventions are in `docs/content.md`; read it before writing files.

Flow: **submission → standardized draft (private) → validation → maintainer
approval → public database → publication.**

The GitHub repository is public and anything committed stays in its history,
so everything unapproved lives in the git-ignored `private/` folder:

| What                                              | Where                             | Public?                                |
| ------------------------------------------------- | --------------------------------- | -------------------------------------- |
| Raw submission (text, documents, original photos) | `private/submissions/<anything>/` | never; may be deleted after processing |
| Draft restaurant                                  | `private/drafts/<id>/`            | no                                     |
| Contributor contact details, new contributors     | `private/contributors.json`       | no                                     |
| Approved restaurant (database)                    | `content/restaurants/<id>/`       | yes, once committed                    |
| Contributor display names                         | `content/contributors.json`       | yes, once committed                    |

## Ground rules

- **Never fabricate.** Do not invent experiences, opinions, ratings, verdicts,
  prices, dishes, dish names, tags, names, addresses, coordinates, or photo
  descriptions. Leave a field out when the submission does not support it, and
  report it as missing. Every field except `id`, `status`, `name` is optional;
  `contributorIds` is only needed to publish. Never fill fields to satisfy a
  layout.
- **Keep uncertainty explicit.** Ambiguous or conflicting information ("near
  Rice Village, not sure of the address") stays out and is reported.
- **Opinions belong to the contributor.** Keep their wording and tone in
  `review.md`. You may fix typos, add paragraphs and headings, and make lists;
  do not rewrite, summarize, or add opinions. Write `review.md` only when there
  is meaningful written content; a photos-only submission has no review.
- **Controlled values use keys**, never display text:
  - `rating`: only if the contributor clearly gave one of the five labels:
    夯 = 5, 顶级 = 4, 人上人 = 3, NPC = 2 (any case), 拉完了 = 1. "Pretty
    good" or "8/10" is not a rating; leave it out and report it.
  - dish `verdict`: `1` when the contributor recommends the dish, `-1` when
    they warn against it, absent when they gave no clear opinion. Mentioning a
    dish is not a recommendation.
  - `cuisines` and `tags`: keys from `shared/content/vocabulary.ts` (e.g. `sichuan`,
    `date`, `group`). Use a tag only when the contributor said it (e.g. "great
    for dates"). If a needed cuisine or tag does not exist, propose adding it
    to `vocabulary.ts` (and a label to `src/lib/labels.ts`) in your report
    instead of picking a near match.
- **Photos:** only connect a photo to a dish when the submission says which
  photo shows it. Image order decides the cover (the first image); import the
  photo the contributor highlights or the clearest overview first, otherwise
  keep their order. Do not spend effort "choosing" a cover. Place a photo in
  `review.md` only where the contributor's text refers to it; the website
  already shows each photo once (review first, then cover, dish cards, and a
  gallery for the rest), so do not reference photos just to make them appear.
- **Existing restaurants:** one restaurant has one record and one review.
  Search `content/restaurants/` (and `private/drafts/`) for the restaurant
  first, by name, alternative name, and address. Restaurants can share a name,
  so compare the address or location before deciding it is the same place. To
  change an existing restaurant, check it out with `content:edit` and edit the
  draft; append new text to the existing review only as the maintainer asks,
  and never delete or rewrite existing content unless asked.
- **Contributors:** look them up with `content:contributor -- find` and reuse
  the id; only add a new contributor when there is no match. Confirm who wrote
  the text and took the photos and that they agree to publication. Contact
  details go only in `private/contributors.json`.
- **Never commit, promote, or publish on your own.** Passing `content:check`
  is not approval. `content:promote` and `content:publish` need `--approved`;
  the tools cannot verify who approved, so pass it only after a maintainer
  explicitly approved that step for that restaurant in this conversation.

## Workflow

Run commands from the repository root. `npm ci` must have been run once.

### 1. Read the submission

Put the files in `private/submissions/<name>/` (git-ignored) or read them where
they are; never edit originals. Read text directly. For documents:

```sh
npm run content:extract -- private/submissions/<name>/review.docx --images-out private/submissions/<name>/docx-images
```

Supported: `.txt`, `.md`, `.docx`, and (macOS textutil or pandoc) `.doc`,
`.rtf`, `.odt`, `.html`. Photos: `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, and
`.heic`/`.heif` (macOS `sips`, or `heif-convert` if installed). For anything
else (PDF, screenshots of text, video), tell the maintainer it cannot be
processed automatically and ask for text or JPEG copies. Documents often embed
photos that were also sent separately; compare them (e.g. with `cmp`) and
import each photo once.

### 2. Find or create the record

```sh
npm run content:check                         # lists every restaurant with its id and name
npm run content:edit -- <id>                  # existing restaurant: copy to private/drafts/<id>/
npm run content:new -- --name "<name>"        # new restaurant: prints the generated id
npm run content:contributor -- find "<name or email>"
npm run content:contributor -- add --name "<display name>" --email "<email>"
```

Ids are generated (e.g. `r-7k3m9q`) and never change, even if the restaurant
is renamed.

### 3. Standardize

```sh
npm run content:add-images -- <id> private/submissions/<name>/IMG_0001.HEIC ...
```

This stores numbered copies (`01-…jpg`, `02-…jpg`; new photos are appended),
upright, at most 2400 px, with all metadata (GPS, camera, time) removed. Then
edit `private/drafts/<id>/info.json` (only supported fields, see
`docs/content.md`) and, if there is written content, `review.md`
(`![alt](images/02-x.jpg "caption")` to place a photo in the text). Keep
`"status": "draft"` and add `contributorIds`.

### 4. Validate and report

```sh
npm run content:check -- <id>
npm run dev:drafts        # local preview, drafts marked 草稿预览
```

Fix every `error` and `draft` line. Report to the maintainer:

- the draft path, id, and what you created or changed;
- facts from the submission vs. from elsewhere (with source), and any derived
  values (e.g. a per-person price from a total);
- missing, uncertain, or conflicting information (from `content:check` and your reading);
- photos without a known subject, unprocessed formats, proposed new vocabulary keys;
- contributor ids used or created, and the permission/attribution status;
- that the draft is private and nothing has been committed or published.

### 5. Add to the public database (maintainer decision)

```sh
npm run content:promote -- <id>              # shows what becomes public or changes
npm run content:promote -- <id> --approved   # only after explicit approval
```

Promotion re-validates, requires `contributorIds`, rejects photos with
metadata, lists the files that become public (or the file changes for an
edit), and adds new contributors' display names to `content/contributors.json`
(contact details stay private). Explain that once committed these files are
public in Git history. A new restaurant stays `"status": "draft"`; an edit
keeps the public restaurant's status. Commit only if the maintainer asks.

### 6. Publish (maintainer decision)

```sh
npm run content:publish -- <id>              # validates and describes the change
npm run content:publish -- <id> --approved   # only after explicit approval
```

The site updates when the change is merged into `main`. Raw submissions in
`private/submissions/` can then be deleted if the maintainer agrees.
