---
name: restaurant-intake
description: Turn a contributor's restaurant submission (plain text, Markdown, Word documents, and photos in JPEG/PNG/WebP/HEIC) into a validated Rice Eats draft under content/restaurants/, then report what is missing for maintainer review. Use when someone provides restaurant notes, a review, or food photos to add or update on the site. Never publishes without explicit maintainer approval.
---

# Restaurant content intake

Contributors send ordinary text and photos. Your job is to turn them into a
draft restaurant folder that passes validation, without inventing anything, and
to hand it back to a maintainer for review. The schema and conventions are in
`docs/content.md`; read it before writing files.

## Ground rules

- Never fabricate. Do not invent dining experiences, opinions, ratings, prices,
  dishes, names, addresses, coordinates, or photo descriptions. If the
  submission does not say it, leave the field out and list it as missing.
- Facts versus opinions: the contributor's opinions are theirs. Keep their
  wording and tone. You may fix obvious typos, add paragraph breaks and
  headings, and turn lists into Markdown lists. Do not rewrite, summarize, or
  "improve" subjective text, and do not add your own opinions.
- Only link a photo to a dish when the submission says which photo shows it
  (a caption, file name, or explicit sentence). Otherwise use neutral alt text
  such as "投稿照片 1" and list the photo as needing a caption.
- Public facts (address, coordinates, Google Maps link) may only come from the
  submission or from a source the maintainer approves. If you look something
  up, say where it came from in your report. Never guess coordinates.
- Never overwrite or delete existing content. `content:new` refuses existing
  folders and `content:add-images` never overwrites files. To update an
  existing restaurant, edit its files in place, show the diff, and keep
  everything the contributor did not ask to change.
- Contributor rights: confirm who wrote the text and took the photos, and that
  they agree to publication on the site. Record them in `contributors`. If
  permission or authorship is unclear, say so in the report; do not publish.
- Keep everything a draft. Only run `content:publish` after a maintainer
  explicitly approves publication of that restaurant.
- Raw submissions stay out of git. Put them in `submissions/<id>/` (ignored by
  git) or leave them where the contributor put them. Originals are never modified.

## Workflow

Run commands from the repository root. `npm ci` must have been run once.

1. **Inspect the submission.** List the files. Read text files directly. For
   documents, extract text and embedded images:

   ```sh
   npm run content:extract -- path/to/review.docx --images-out submissions/<id>/docx-images
   ```

   Supported: `.txt`, `.md`, `.docx`, and (macOS textutil or pandoc) `.doc`,
   `.rtf`, `.odt`, `.html`. Photos: `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`,
   and `.heic`/`.heif` (converted on macOS). For anything else (PDF, screenshots
   of text, video), tell the maintainer it cannot be processed automatically
   and ask for text or a supported format.

2. **Identify the restaurant.** Find its name and any facts given. Check
   `content/restaurants/` for an existing folder with the same restaurant
   (similar name or address) before creating a new one. Choose a lowercase
   ASCII `id`, e.g. `huynh-restaurant`.

3. **Create the draft.**

   ```sh
   npm run content:new -- <id> --name "<restaurant name>"
   ```

4. **Import photos.** This copies them into `images/`, converts HEIC, rotates
   them upright, caps them at 2400 px, and strips EXIF/GPS metadata (the
   repository is public). Originals are untouched. Documents often embed the
   same photos that were also sent as files; compare them (for example with
   `cmp`) and import each photo only once.

   ```sh
   npm run content:add-images -- <id> path/to/photo1.jpg path/to/IMG_0002.HEIC
   ```

5. **Write `info.json`.** Fill only fields supported by the submission:
   `cuisines`, `neighborhood`, `address`, `location`, `tier`
   (`夯 | 顶级 | 人上人 | npc | 拉完了`), `pricePerPerson` (USD per person),
   `tags`, `summary` (short, from the contributor's words), `cover`, `coverAlt`,
   `dishes` (`name`, `verdict` `推荐 | 不推荐`, `comment`, `image`, `imageAlt`),
   `links`, `contributors`. Keep `"status": "draft"`.

6. **Write `review.md`.** Put the contributor's long-form text here. Reference
   photos with `![alt text](images/file.jpg "optional caption")`; a photo on its
   own line becomes a figure with a caption. Raw HTML is not allowed and is
   stripped. Leave `review.md` empty if there is no long-form text.

7. **Validate and process.**

   ```sh
   npm run content:check -- <id>
   ```

   Fix every `error` and `draft` line. The `missing` line lists optional or
   required information that is still absent. `npm run images -- <id>` shows the
   generated renditions if you need to check image processing.

8. **Preview (optional).** `npm run dev:drafts` serves the site with drafts
   included, marked as 草稿预览.

9. **Report for review.** Give the maintainer:
   - the folder path and a short summary of what you created;
   - which facts came from the submission and which from elsewhere (with source),
     and any values you derived (e.g. a per-person price from a total);
   - anything missing, uncertain, or conflicting (from `content:check` and your reading);
   - photos you could not match to a dish or caption;
   - formats you could not process;
   - permission/attribution status.

   State clearly that the restaurant is still a draft and will not appear on
   the site until a maintainer approves it.

10. **Publish only on approval.** When a maintainer explicitly approves:

    ```sh
    npm run content:publish -- <id>
    ```

    This re-validates and refuses to publish (leaving it a draft) if anything
    is wrong, including missing `contributors`. Then commit the folder.
