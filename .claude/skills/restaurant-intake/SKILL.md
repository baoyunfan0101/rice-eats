---
name: restaurant-intake
description: Turn a contributor's restaurant submission (plain text, Markdown, Word documents, and photos in JPEG/PNG/WebP/HEIC) into a private, validated Rice Eats draft in drafts/, then report what is missing for maintainer review. Use when someone provides restaurant notes, a review, or food photos to add or update on the site. Never commits, promotes, or publishes anything without explicit maintainer approval.
---

# Restaurant content intake

Contributors send ordinary text and photos. Your job is to turn them into a
private draft that passes validation, without inventing anything, and to hand
it to a maintainer for review. The schema and conventions are in
`docs/content.md`; read it before writing files.

The GitHub repository is public. Anything committed, even on a branch or in a
pull request, stays visible in Git history. So drafts and submissions live in
git-ignored folders until a maintainer approves them:

| Stage                       | Where                                                | Who can see it                             |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Raw submission              | `submissions/<id>/` (git-ignored)                    | only this computer                         |
| Draft                       | `drafts/<id>/` (git-ignored)                         | only this computer                         |
| Approved for the repository | `content/restaurants/<id>/`, `"status": "draft"`     | anyone, once committed; not on the website |
| Published                   | `content/restaurants/<id>/`, `"status": "published"` | anyone; on the website                     |

## Ground rules

- Never fabricate. Do not invent dining experiences, opinions, ratings, prices,
  dishes, names, addresses, coordinates, or photo descriptions. If the
  submission does not say it, leave the field out and list it as missing.
- Keep uncertainty explicit. If something is ambiguous or conflicting (e.g.
  "near Rice Village, not sure of the address"), leave the field out and
  report it; do not pick a value.
- The contributor's opinions are theirs. Keep their wording and tone. You may
  fix obvious typos, add paragraph breaks and headings, and turn lists into
  Markdown lists. Do not rewrite or "improve" subjective text, and do not add
  your own opinions.
- Only link a photo to a dish when the submission says which photo shows it
  (a caption, file name, or explicit sentence). Otherwise use neutral alt text
  such as "投稿照片 1" and list the photo as needing a caption.
- Public facts (address, coordinates, Google Maps link) may only come from the
  submission or from a source the maintainer approves. If you look something
  up, say where it came from. Never guess coordinates.
- Rating: translate a rating label only when the contributor clearly used one:
  夯 = 5, 顶级 = 4, 人上人 = 3, NPC = 2, 拉完了 = 1 (case-insensitive for NPC).
  Store the number in `"rating"`. Anything else ("pretty good", "8/10") is not
  a rating: leave it out and report it.
- Never overwrite or delete existing content. `content:new` refuses existing
  folders, `content:add-images` never overwrites files, and `content:promote`
  never replaces a folder. To update a published restaurant, edit its files in
  place, show the diff, and keep everything the contributor did not ask to change.
- Contributor rights: confirm who wrote the text and took the photos, and that
  they agree to publication on the site. Record them in `contributors`. If this
  is unclear, say so; it blocks promotion.
- Never commit, promote, or publish on your own. Passing `content:check` is not
  approval. `content:promote` and `content:publish` need `--approved`; the tools
  cannot verify who approved, so pass it only after a maintainer has explicitly
  approved that step for that restaurant in this conversation.

## Workflow

Run commands from the repository root. `npm ci` must have been run once.

### 1. Prepare a private draft

1. **Keep the originals.** Copy the contributor's files into
   `submissions/<id>/` (git-ignored) or read them where they are. Never edit
   them.
2. **Inspect the submission.** Read text files directly. For documents,
   extract text and embedded images:

   ```sh
   npm run content:extract -- submissions/<id>/review.docx --images-out submissions/<id>/docx-images
   ```

   Supported: `.txt`, `.md`, `.docx`, and (macOS textutil or pandoc) `.doc`,
   `.rtf`, `.odt`, `.html`. Photos: `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`,
   and `.heic`/`.heif` (macOS only, via `sips`). For anything else (PDF,
   screenshots of text, video, HEIC on other systems), tell the maintainer it
   cannot be processed automatically and ask for text or JPEG copies.

3. **Identify the restaurant.** Find its name and any facts given. Check
   `content/restaurants/` and `drafts/` for the same restaurant before creating
   a new one. Choose a lowercase ASCII `id`, e.g. `huynh-restaurant`.
4. **Create the draft** (in `drafts/`):

   ```sh
   npm run content:new -- <id> --name "<restaurant name>"
   ```

5. **Import photos.** Writes clean copies to `drafts/<id>/images/`: HEIC
   converted, rotated upright, at most 2400 px, and all metadata (GPS, camera,
   time) removed. Originals are untouched. Documents often embed the same
   photos that were also sent as files; compare them (e.g. with `cmp`) and
   import each photo once.

   ```sh
   npm run content:add-images -- <id> submissions/<id>/IMG_0001.HEIC
   ```

6. **Write `info.json`.** Fill only fields supported by the submission:
   `cuisines`, `neighborhood`, `address`, `location`, `rating` (1-5),
   `pricePerPerson` (USD per person), `tags`, `summary` (short, from the
   contributor's words), `cover`, `coverAlt`, `dishes` (`name`, `verdict`
   `推荐 | 不推荐`, `comment`, `image`, `imageAlt`), `links`, `contributors`.
   Keep `"status": "draft"`.
7. **Write `review.md`** with the contributor's long-form text. Photos:
   `![alt text](images/file.jpg "optional caption")`. Raw HTML is stripped.

### 2. Validate and review

```sh
npm run content:check -- <id>
npm run dev:drafts        # local preview, drafts marked 草稿预览
```

Fix every `error` and `draft` line. Then report to the maintainer:

- the draft path and a short summary of what you created;
- which facts came from the submission, which from elsewhere (with source), and
  any values you derived (e.g. a per-person price from a total);
- anything missing, uncertain, or conflicting (from `content:check` and your reading);
- photos you could not match to a dish or caption, and formats you could not process;
- the contributor permission and attribution status;
- that the draft is private and nothing has been committed or published.

### 3. Approve for the public repository (maintainer decision)

Show what would become public:

```sh
npm run content:promote -- <id>
```

It validates the draft, requires `contributors`, rejects photos with metadata,
and lists every file that would enter the public repository. Explain to the
maintainer that once committed these files are public in Git history, even if
the restaurant is never shown on the website. Only after the maintainer
explicitly approves:

```sh
npm run content:promote -- <id> --approved
```

This moves the folder to `content/restaurants/<id>/` (still `"status": "draft"`,
so not on the website). Commit it only if the maintainer asks you to.

### 4. Publish on the website (maintainer decision)

```sh
npm run content:publish -- <id>              # validates and describes the change
npm run content:publish -- <id> --approved   # only after explicit approval
```

Publishing re-validates and keeps the restaurant a draft if anything is wrong.
The site updates when the change is merged into `main`.
