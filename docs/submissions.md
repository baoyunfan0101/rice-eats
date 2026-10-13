# Public submissions (Tally)

Visitors can send a review, photos, or both through a hosted
[Tally](https://tally.so) form, without GitHub or an account. Nothing they
send is published automatically:

```text
Rice Eats website (choose + confirm restaurant) -> Tally form -> Gmail notification
  -> local intake (Agent) -> human review -> content/ (database) -> static website
```

- **Website** (`src/`): a "投稿" link in the header, a "补充点评或照片" box on
  each restaurant page, and the submission page `/rice-eats/submit/`. There
  the contributor first chooses the restaurant, then confirms it
  ("确认餐厅" / "重新选择"), and only then sees the embedded form (with a
  direct link to the Tally-hosted form as a fallback). The form loads only on
  that page, and the website never writes to the database.
- **Restaurant selection** (`src/views/RestaurantSelector.tsx`,
  `src/views/PickerMap.tsx`, `src/lib/poi.ts`) is map-first. The map opens on
  Rice University and shows the restaurants in view (restaurants, fast food,
  cafes, food courts from the
  [Geoapify Places API](https://apidocs.geoapify.com/docs/places/)) as pins;
  clicking a pin selects that restaurant. Panning or zooming updates the pins
  once the map settles. "使用当前位置" only moves the map (the browser asks
  for location after that click, never on load); discovery then works as for
  any other area. The device position is never submitted; the location sent
  is the chosen place's (or the contributor's map marker).
  - Discovery loads fixed tiles of 0.01° (about 1 km) covering the visible
    area, each cached for the session, so panning back and forth reuses them.
    A Geoapify tile asks for up to 500 places (Geoapify's maximum); credits
    are charged per place returned (one per 20), not per limit, so a first
    view costs at most a few dozen credits and usually far less. If a tile (or
    an Overpass batch, up to 2,000 places) reaches its limit, the page says
    some restaurants may be missing and suggests zooming in or searching by
    name. Below zoom 14, or when the view would need more than 30 tiles, the
    page asks the contributor to zoom in instead of searching.
  - Each tile loads independently: restaurants from tiles that loaded stay on
    the map when others fail, the page says part of the area did not load,
    and "重试" (or moving the map) loads only the failed tiles again (failures
    are not cached). When nothing loads, the previous pins stay with an error
    and "重试". Results for an area the map has already left are ignored.
  - A name search ("按名字搜索") finds a specific restaurant within 5 km of the
    map center, snapped to a ~2 km grid: moving the map to another cell
    searches again, and results are only shown for the query and area they
    were made for, so late answers never replace newer ones. If the place is
    missing, or search is unavailable, "手动添加餐厅" takes a name, an optional
    address, and a map marker; a name alone is allowed and is marked for
    location verification.
  - **Free fallback:** when there is no Geoapify key, Geoapify refuses the key
    (credits used up: HTTP 401/403/429, after which Geoapify is skipped for
    the rest of the session), or a Geoapify request fails, the search goes to
    the free OpenStreetMap
    [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (no key;
    named `amenity` restaurant, fast_food, cafe, or food_court within the tile
    or around the map center). Geoapify itself serves OpenStreetMap data, so
    both find the same places; Overpass addresses are sparser (street and
    number when tagged). Such selections send `poi_provider=osm` and
    `poi_id=<node|way|relation>/<id>`. To respect the public server's
    fair-use limits (about two concurrent requests per visitor, roughly 10,000
    a day), all tiles of a view that need Overpass (every tile without a key,
    or the tiles Geoapify could not load) are fetched in one request for their
    bounding box and split back into tiles, at most two Overpass requests run
    at once, and a busy answer (504) is retried once. If Overpass still
    fails, the page shows an error with "重试", and manual entry still works.
  - Arriving from a restaurant page skips the selection (with "更换餐厅" to
    choose another). The page shows the data attribution (Geoapify and
    OpenStreetMap, or OpenStreetMap alone without a key) and a short note that
    the map area and name searches are sent to these services.
- **Tally**: collects the text, photos, rating, credit, contact email, and
  consent. Free-plan features only.
- **Gmail** (`hello.riceeats@gmail.com`): receives a notification per
  submission. It is a queue, not a database.
- **Local intake** (`npm run content:submission`, the `restaurant-intake`
  Skill): copies a submission into the git-ignored `private/` folder, prepares
  a private draft, and waits for the maintainer's approval.

The shared contract (hidden-field names, question titles, rating options, the
form setting) is defined once in `shared/submission.ts`. Components only see a
provider-independent `RestaurantCandidate`; Geoapify and the Overpass
fallback are implemented in `src/lib/poi.ts`.

## Maintainer setup (one time)

These steps happen in the maintainer's Tally and Gmail accounts; no agent has
access to them. Menu names may differ slightly in Tally's editor.

1. **Account.** Sign in to Tally with `hello.riceeats@gmail.com` (create the
   account if needed). The notification emails go to the account's address.
2. **Create a form**, e.g. "Rice吃啥 投稿", with these blocks in this order.
   Keep the question titles exactly as written (intake finds answers in the CSV
   export by these titles, defined in `shared/submission.ts`):

   | Block              | Title / name            | Settings                                                                                                 |
   | ------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------- |
   | Hidden fields      | `restaurant_id`         | Rice Eats id, only for a restaurant already on the site.                                                 |
   |                    | `restaurant_name`       | The confirmed restaurant name.                                                                           |
   |                    | `restaurant_lat`        | Latitude of the chosen place or marker (6 decimals); empty for a name-only entry.                        |
   |                    | `restaurant_lng`        | Longitude, as above.                                                                                     |
   |                    | `restaurant_address`    | Address, when known.                                                                                     |
   |                    | `poi_provider`          | `geoapify` or `osm` (Overpass fallback) for a place from the map or search.                              |
   |                    | `poi_id`                | The provider's place id (private; never a Rice Eats id).                                                 |
   |                    | `selection_method`      | `existing`, `poi`, or `manual`.                                                                          |
   |                    | `source`                | `site` or `restaurant-page`.                                                                             |
   | Text               |                         | "餐厅：@restaurant_name" (a field reference), then the intro: manual review, no guarantee.               |
   | Multiple choice    | `总体评级`              | Optional, nothing preselected. Options exactly: `🥵 夯`, `😘 顶级`, `🤤 人上人`, `🫤 NPC`, `🤮 拉完了`.  |
   | Long answer        | `你的点评`              | **Required.** Placeholder: "随便写，口味、环境、推荐或踩雷的菜都可以。"                                  |
   | Text               |                         | "可以上传环境、菜单等照片。想单独点评某道菜的话，可以在下面添加这道菜，并上传它的照片。"                 |
   | File upload        | `照片`                  | Optional; for photos that are not of one dish (room, menu). Multiple, max 10, 10 MB, images.             |
   | Text               |                         | "想单独推荐或避雷某道菜？点「＋ 添加一道菜」，一道一道地加（选填）。"                                    |
   | Checkboxes         | `菜品1 添加`            | Optional, one unchecked option `＋ 添加一道菜`.                                                          |
   | Short answer       | `菜品1 名称`            | **Required** (only while shown).                                                                         |
   | Multiple choice    | `菜品1 评价`            | **Required** (only while shown), nothing preselected. Options exactly: `🔥 推荐`, `💣 避雷`.             |
   | File upload        | `菜品1 照片`            | Optional; photos of this dish only. Multiple, max 3, 10 MB, images.                                      |
   | Short answer       | `菜品1 点评`            | Optional; one sentence about the dish.                                                                   |
   | (same five blocks) | `菜品2 …` to `菜品10 …` | Same settings, with the option `＋ 再添加一道菜` (step 4).                                               |
   | Short answer       | `署名`                  | Optional. Placeholder: "采用后会显示在网站上；不填则显示为「匿名」"; intake credits a blank name as 匿名 |
   | Email              | `联系邮箱`              | Optional. Placeholder: "只用于和你沟通，不会公开"                                                        |
   | Checkboxes         | `发布授权`              | Required, one unchecked option whose text starts with `我同意` (consent text below).                     |
   | Conditional logic  |                         | See step 4.                                                                                              |
   | reCAPTCHA          |                         | Native spam protection.                                                                                  |
   | 'Thank you' page   |                         | Confirmation text (step 9).                                                                              |

   Consent option text (`发布授权`); intake treats an answer starting with
   `我同意` as consent:

   > 我同意：我有权提交这些文字和照片（文字由我撰写，照片由我拍摄或已获授权），并授权 Rice吃啥
   > 审核；审核通过后可按约定的署名在网站上复制和展示。我了解投稿不保证发布，内容可能为统一格式而编辑
   > 但不会歪曲我的观点，联系方式不会公开显示。

   In the form settings, set the language to Chinese (Simplified) so buttons
   and messages are in Chinese.

3. **Hidden fields.** The names must be exactly as in the table; the website
   passes only the non-empty ones as URL parameters, e.g.
   `?restaurant_name=...&restaurant_lat=29.717400&restaurant_lng=-95.401800&restaurant_address=...&poi_provider=geoapify&poi_id=...&selection_method=poi&source=site`.
   The form has no name question: the restaurant is chosen and confirmed on
   the website, and the form shows it through the `@restaurant_name` field
   reference (to change it, contributors use "更换餐厅" on the website). The
   fields are context, not proof: intake checks them against the database.
4. **Conditional logic** (Tally's conditional logic blocks):
   - Dishes are added one at a time, like entries on a résumé. The
     `菜品1 名称`, `评价`, `照片`, and `点评` questions are hidden by default
     and shown when `菜品1 添加` is checked. `菜品2 添加` is shown only when
     `菜品1 添加` is checked, and shows the `菜品2` questions; the same for
     `菜品3` to `菜品10`. Tally does not enforce required questions while they
     are hidden, so a dish's name and verdict are required only once the
     contributor adds that dish. Intake also reports dishes without a name or
     verdict and submissions without a review, so a gap here never publishes
     anything.
   - Option labels carry the same emoji as the website (`src/lib/labels.ts`);
     intake accepts the answers with or without the emoji.
5. **Photos.** In each file upload block, allow multiple files, limit the
   count (10 general, 3 per dish), set 10 MB per file (the free-plan maximum),
   and accept .jpg, .jpeg, .png, .heic, and .webp. HEIC from iPhones is fine:
   intake converts it. Each dish's photos stay attached to that dish.
6. **Consent.** The `发布授权` question is required with a single unchecked
   option. Never prefill it.
7. **Spam protection.** Add the captcha block or enable the form's spam
   protection setting.
8. **Notifications.** In the form's integrations or settings, turn on **Self
   email notifications** to `hello.riceeats@gmail.com`.
9. **Confirmation.** Customize the thank-you page (or message) to:

   > 投稿已收到，谢谢！我们会先人工审核，内容不会立即出现在网站上，也不保证一定发布。
   > 如果留了邮箱，我们可能会就署名或细节联系你。

   Do not say that a restaurant page has been updated.

10. **Publish** the form and copy its share link (`https://tally.so/r/<id>`).
11. **Configure the website**: set `TALLY_FORM` in `site.config.ts` to that
    link, open a pull request, and merge it after CI passes. While the setting
    is empty the website hides every submission link and `/submit/` shows
    "投稿功能即将开放"; a malformed value fails `npm run build`. The form link
    is public and is not a secret; never put API keys, passwords, or tokens in
    the repository.
12. **Restaurant search (Geoapify).** Create a free account at
    [geoapify.com](https://www.geoapify.com/), create a project, and copy its
    API key. In the key's settings, restrict it to the site's origin
    (`https://baoyunfan0101.github.io`, plus `http://localhost:5173` only if
    you also use it locally) and, if offered, to the Places API, so the key
    is useless elsewhere. The key ships in the page, so it is a repository
    **variable**, not a secret: Settings > Secrets and variables > Actions >
    Variables > `GEOAPIFY_API_KEY`; the deploy workflow passes it to the
    build as `VITE_GEOAPIFY_API_KEY`. For local development put
    `VITE_GEOAPIFY_API_KEY=<key>` in `.env.local` (git-ignored). Never commit
    a key or use an unrestricted one. Without a key the site still builds and
    the map uses the free OpenStreetMap Overpass fallback. Watch the free
    quota in the Geoapify dashboard; when it is exhausted the page switches to
    Overpass for the rest of the visit.
13. **Verify end to end** with the checklist below.

## Handling submissions

### Gmail

Create the labels `RiceEats/New`, `RiceEats/Reviewing`, and
`RiceEats/Processed`. Optionally add a Gmail filter on the sender of Tally's
notification emails (as shown on the first notification) that applies
`RiceEats/New`; do not filter on the subject, which depends on the form name.

The Tally **Submissions** tab of the form is the reliable list of everything
received; the email is only the alert. Each submission has a submission id
(shown in the dashboard and the CSV export). An unprocessed submission is one
whose id is not in `npm run content:submission -- list`; move its email from
`RiceEats/New` to `RiceEats/Reviewing` while working on it and to
`RiceEats/Processed` afterwards.

### Intake

1. Export the responses from Tally's Submissions tab as CSV and save it under
   `private/`. Alternatively, transcribe one notification email into a JSON
   file under `private/` (only `submissionId` and `consent` are required;
   `consent` is `true` only if the email shows `发布授权: 我同意`):

   ```json
   {
     "submissionId": "<id from Tally>",
     "submittedAt": "2026-10-12 18:00",
     "source": "restaurant-page",
     "restaurantId": "r-abc123",
     "restaurantName": "示例拉面",
     "restaurantAddress": "6100 Main St, Houston",
     "restaurantLocation": { "lat": 29.7174, "lng": -95.4018 },
     "poi": { "provider": "geoapify", "id": "<place id>" },
     "selectionMethod": "existing",
     "review": "…",
     "ratingAnswer": "顶级",
     "photoUrls": ["https://storage.tally.so/…"],
     "dishes": [
       {
         "name": "豚骨拉面",
         "verdictAnswer": "推荐",
         "comment": "…",
         "photoUrls": ["https://storage.tally.so/…"]
       }
     ],
     "displayName": "小明",
     "email": "…",
     "consent": true
   }
   ```

2. Import it:

   ```sh
   npm run content:submission -- import private/tally-export.csv
   ```

   For each submission this stores `submission.json` and the photos in
   `private/submissions/tally-<submission id>/`, records the id in the private
   log `private/submissions/tally-log.json` (so it is never imported twice,
   even after the files are deleted), and reports the restaurant match,
   dishes (with their verdicts and photo numbers), rating, credit, consent,
   photo state, and problems. It creates no drafts
   and changes nothing in `content/`. `--skip-photos` records the photos as
   pending without downloading them.

   The restaurant match is a proposal, resolved in this order: the
   `restaurant_id` (checked against the submitted name and location), then a
   POI that an earlier reviewed submission linked to a restaurant (`mark
--status drafted|processed --id <restaurant id>` records that link in the
   private log), then nearby restaurants (within 150 m) and restaurants with
   the same name or an alternative name, each with its distance. A name
   alone never merges two places: chains have branches with the same name,
   so a far-away same-name restaurant is listed as a possible other branch.
   Manual entries, names without a location, and invalid coordinates are
   reported for verification. POI ids stay in `private/` and are never
   copied into `content/`.

3. Check that the photo intake is complete, and recover missing photos (see
   [Photos](#photos) below).
4. Ask the agent to process the imported submission with the
   `restaurant-intake` Skill. It prepares a private draft (or proposes changes
   to an existing restaurant's single review), and reports what it did.
5. Review and approve as usual (`content:promote`, `content:publish`). Then
   record the outcome:

   ```sh
   npm run content:submission -- mark <submission id> --status drafted --id <restaurant id>
   npm run content:submission -- mark <submission id> --status processed --id <restaurant id>
   npm run content:submission -- mark <submission id> --status rejected
   ```

### Photos

Each photo link of a submission has a number (general photos first, then
each dish's photos in order) and is stored as `photo-<NN>.<ext>`; the report
shows which dish a photo belongs to. Its state is kept in
`photos.json` next to `submission.json`, and `content:submission -- list`
shows each submission's photo intake as `none`, `complete`, or `incomplete`.

| State        | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `pending`    | Not downloaded yet (e.g. imported with `--skip-photos`).             |
| `failed`     | The last attempt failed; the report shows why (without link tokens). |
| `downloaded` | Fetched and verified.                                                |
| `recovered`  | Added by hand and verified.                                          |
| `waived`     | The maintainer decided to proceed without it.                        |
| `excluded`   | Beyond the form's limit (10 general, 3 per dish); never fetched.     |

`pending` and `failed` photos make the intake incomplete. Stored photos are
re-verified (present, a real image, unchanged) whenever a submission is
read; a missing or changed file goes back to `failed`, and a changed file is
moved aside rather than overwritten.

```sh
npm run content:submission -- status <submission id>         # re-check; no downloads
npm run content:submission -- retry-photos <submission id>   # fetch only pending/failed photos
npm run content:submission -- add-photo <submission id> <photo number> <file>
npm run content:submission -- waive-photo <submission id> <photo number>
```

Importing the same export again also continues an incomplete intake;
a submission whose intake is complete is skipped without any download.
Retries never fetch verified photos again, never create second copies, and
can be repeated safely.

If a link has expired or needs the Tally login, open the submission in the
Tally dashboard, download the photo, and add it with `add-photo` (it must be
a JPEG, PNG, WebP, or HEIC image of at most 10 MB; the original file is not
changed). If the maintainer decides to go ahead without it, use
`waive-photo`. A photo-only submission without any retrieved photo is
BLOCKED until a photo is recovered or the submission is rejected; a
submission with text or some photos can be drafted once the maintainer has
decided about the missing ones.

**Download security.** Photo links come from untrusted submissions, so every
request, including each redirect, is checked before it is made: https only,
no credentials in the link, the default port, and an exact host from the
trusted list in `scripts/content/safe-fetch.ts` (`tally.so`,
`storage.tally.so`; no wildcards and no IP addresses). Every
address the host's DNS returns must be globally routable unicast: loopback,
private, link-local, cloud metadata, documentation, multicast, and other
special-purpose ranges (IANA registries) are rejected for IPv4 and IPv6,
IPv4-mapped IPv6 addresses (`::ffff:7f00:1`) are judged by the IPv4 address
they contain, and one bad answer blocks the request. Redirects are followed by hand, at most
3, without loops. Each download is limited to 30 seconds and 10 MB however
the server describes it, and is kept only if its content is an image; file
names never come from the submission. When Tally serves a file from a host
that is not on the list, the download fails closed: add the photo by hand,
and update the list only after confirming the host belongs to Tally. The DNS
check runs just before each request; it is a defense for a local tool, not a
guarantee against an attacker who controls DNS between the check and the
connection.

Contact emails stay in `private/` (`submission.json`, and
`private/contributors.json` when a contributor is registered); they never
enter `content/` or the website build. Raw submissions are not committed; once
processed they can be deleted, while the log keeps the ids.

## End-to-end verification (after setup)

Automated tests use a stub instead of Tally, so the live integration must be
checked by hand once the form exists:

1. Open https://baoyunfan0101.github.io/rice-eats/ and use the "投稿" link.
   Check that pins appear around Rice University without any action, click
   one, confirm it, and submit a text-only test response.
2. Use "使用当前位置" (allow the permission) and check that the map moves and
   the pins update; pan the map elsewhere and check again. Search a
   restaurant by name and submit a photo-only test response. Then deny the
   location permission once and check that the message appears and the map
   still works.
3. Add a restaurant by hand (name and marker) and submit a test response.
4. On a restaurant page, use "补充点评或照片" and submit a test response.
5. In Tally, confirm the responses recorded `restaurant_name`,
   `restaurant_lat` / `restaurant_lng`, `selection_method` (`poi`, `poi`,
   `manual`, `existing`), `poi_provider` / `poi_id` for the first two,
   `restaurant_id` and `source=restaurant-page` for the fourth, and
   `source=site` for the others, and that the form showed the restaurant name. Include a dish with a photo
   in one response and check that the import lists the photo under that dish.
6. Confirm three notification emails arrived at `hello.riceeats@gmail.com`.
7. Export the CSV, run `npm run content:submission -- import`, and confirm the
   photos were downloaded (`photos: complete`). If Tally serves them from a
   host outside the trusted list, note the host, recover the photos with
   `add-photo`, and review the list.
8. Ask the agent to prepare a private draft from one test submission and
   check it with `npm run content:check`.
9. Confirm `git status` shows no changes in `content/` and nothing under
   `private/` is tracked. Then delete the test submissions in Tally and the
   test folders in `private/`, and mark them `rejected`.
