# Public submissions (Tally)

Visitors can send a review, photos, or both through a hosted
[Tally](https://tally.so) form, without GitHub or an account. Nothing they
send is published automatically:

```text
Rice Eats website (step 1: choose restaurant) -> Tally form (step 2) -> Gmail notification
  -> local intake (Agent) -> human review -> content/ (database) -> static website
```

- **Website** (`src/`): a "投稿" link in the header, a "补充点评或照片" box on
  each restaurant page, and the submission page `/rice-eats/submit/`. There
  the contribution has two steps. "第一步 · 选择餐厅": clicking a pin (or a
  search result, or finishing manual entry) selects the restaurant in place:
  the map centers on it, the pin turns dark with a red label, and a "已选餐厅"
  panel shows its name and address with "下一步：填写点评 →". There is no
  separate confirmation page. "第二步 · 填写点评" shows the restaurant name
  once in the heading ("为「…」投稿") with "更换餐厅" as a secondary action
  (back to step 1, keeping the selection and restoring the map where the
  contributor left it), then the embedded form. The form loads only on that
  page, and the website never writes to the database.
- **Form loading** (`src/views/SubmitPage.tsx`): the iframe's load event also
  fires for Tally's error pages, so the page waits instead for Tally's own
  `Tally.FormLoaded` message, which embedded forms post to the parent page
  (accepted only from `https://tally.so`, from that iframe, for this form
  id). Until then a short "正在加载投稿表单…" note is shown. Without the
  message after 10 seconds (offline, blocked, Tally unavailable, or an error
  page inside the frame), the page says the form did not load properly and
  offers "重新加载表单" (a fresh iframe and a fresh check) and
  "在新窗口打开投稿表单" (the Tally-hosted form with the same hidden fields).
  Neither appears while the form works. Choosing another restaurant starts a
  fresh form and check.
- **Search area** (`src/views/AreaPicker.tsx`, `src/lib/areas.ts`,
  `src/lib/geocode.ts`): step 1 starts with "选择查找区域" (A), then the
  restaurant is chosen (B) on the same page, each in its own box under the
  page title and the step ("投稿：分享你的用餐体验", then "第一步 · 选择餐厅").
  One group of controls moves the map: "使用当前位置" first and highlighted
  (the browser asks only after that click; a denial leaves the other ways),
  then "Rice University 周边" and "Chinatown 周边" (Bellaire Blvd in
  southwest Houston, between Dun Huang Plaza and Hong Kong City Mall; static
  coordinates, no request). "或者：输入地址或地点" is a fallback that opens
  an address, landmark, or place search when clicked (searched only when
  submitted). A single
  match moves the map at once; several are listed by name and address to
  choose from; a failed search offers "重试", and the presets, the current
  location, the map, and manual entry keep working. The last request wins:
  each action (a preset, "使用当前位置", a search, choosing a result,
  choosing a restaurant, placing a manual marker, or dragging or zooming the
  map by hand) cancels the pending search and makes any older answer, including a late
  device location or a late error, change nothing, so the map always ends
  where the contributor last asked for. Hand moves are recognized
  from their input (`src/views/PickerMap.tsx`: Leaflet's `dragstart`, the
  wheel, a double click, a two-finger touch, the zoom buttons, and the map's
  keys), never from `moveend`/`zoomend`, which programmatic `setView` calls
  (a preset, a search result, a selection, restoring the view) also fire;
  the area controls and the map share one `LocateIntent`
  (`src/lib/locateIntent.ts`). "当前查找区域：…" names the area while the map is within about
  1.2 km of its center, and "地图当前位置附近" once the contributor has moved
  away. Choosing an area only moves the map: it never selects a restaurant,
  and the selected restaurant and the area are separate (both are kept when
  coming back from step 2).
- **Restaurant selection** (`src/views/RestaurantSelector.tsx`,
  `src/views/PickerMap.tsx`, `src/lib/poi.ts`) is map-first. The map opens on
  Rice University and shows the restaurants in view (restaurants, fast food,
  cafes, food courts from the
  [Geoapify Places API](https://apidocs.geoapify.com/docs/places/)) as pins
  labelled with the restaurant name; clicking a pin (or its name) selects that
  restaurant. Labels (`src/lib/labelLayout.ts`) go on the right of a pin, or
  on the left near the right edge, so they stay inside the map; they never
  overlap each other or cover another pin. The selected restaurant's name is
  always shown (truncated only if neither side has room); the others are
  named nearest the map center first, and a pin without room keeps its name
  as a tooltip. The layout follows pans, zooms, resizes, and newly loaded
  pins. Below the map, a collapsed list ("列表查看地图范围内的 N 家餐厅",
  with an expand chevron) names every restaurant in view, nearest the map
  center first, to read and choose from. Choosing a restaurant focuses the map on it; going
  back from step 2 restores the last view instead. Distances are shown in
  miles. Panning or zooming updates the pins
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
  - "或者：在当前区域搜索餐厅" is the fallback to picking on the map, shown
    the same way as the address search. It narrows the pins and the list to
    the restaurants in view whose name contains the text (no request), so the
    list is always the map's area AND the name; it opens by itself while
    searching. The selected restaurant with "下一步：填写点评 →" closes the
    page, below the boxes and the data-source line. If the place is missing,
    "手动添加餐厅" takes the 餐厅名称 and a map marker (drawn like a selected
    restaurant pin, with the name beside it);
    a name alone ("我不确定具体位置") is allowed and is marked for location
    verification. Manual entry has the same area controls but no restaurant
    pins. The area is never the restaurant's location: only the
    contributor's marker is, or a searched place after "用这个地点作为餐厅位置"
    (whose address is then sent; there is no separate address field).
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
  - Arriving from a restaurant page opens step 2 directly (with "更换餐厅" to
    choose another, and "← 返回餐厅页面" while that restaurant is selected). The page names the data sources once
    (Geoapify and OpenStreetMap, or OpenStreetMap alone without a key), in
    one line that also says the map area is sent to them and the device
    position is not submitted.
- **Requests** (cheapest that does the job first): the preset areas need no
  request and the current location comes from the browser. Address search
  uses the Geoapify Geocoding API (same key; one credit per search), biased
  to the map center, only on submit, cached per query and area for the
  session (failures are not cached). There is deliberately no fallback to
  the public OpenStreetMap Nominatim service: its
  [usage policy](https://operations.osmfoundation.org/policies/nominatim/)
  limits the whole site to one request a second, which a static site cannot
  enforce across visitors. Without a key, the page says address search is
  unavailable and sends nothing; when Geoapify refuses or fails, it says so
  and offers "重试". Nearby
  restaurants use Geoapify Places by cached tiles, and the name search only
  filters what is already loaded; Overpass is only the fallback (one batched request per
  view), never queried alongside Geoapify. No details service is needed:
  the places already carry name, address, and coordinates.
- **Tally**: collects the rating, text, photos, dishes, credit, contact email,
  and consent. Free-plan features only.
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
2. **Create a form**, named "Rice Eats 投稿", with these blocks in this order.
   Keep the question titles exactly as written (intake finds answers in the CSV
   export by these titles, defined in `shared/submission.ts`):

   | Block              | Title / name            | Settings                                                                                                    |
   | ------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
   | Hidden fields      | `restaurant_id`         | Rice Eats id, only for a restaurant already on the site.                                                    |
   |                    | `restaurant_name`       | The selected restaurant name.                                                                               |
   |                    | `restaurant_lat`        | Latitude of the chosen place or marker (6 decimals); empty for a name-only entry.                           |
   |                    | `restaurant_lng`        | Longitude, as above.                                                                                        |
   |                    | `restaurant_address`    | Address, when known.                                                                                        |
   |                    | `poi_provider`          | `geoapify` or `osm` (Overpass fallback) for a place from the map or search.                                 |
   |                    | `poi_id`                | The provider's place id (private; never a Rice Eats id).                                                    |
   |                    | `selection_method`      | `existing`, `poi`, or `manual`.                                                                             |
   |                    | `source`                | `site` or `restaurant-page`.                                                                                |
   | Heading 2          |                         | "整体体验" (no intro text and no restaurant name: the website shows both).                                  |
   | Multiple choice    | `总体评级`              | **Required**, nothing preselected. Options exactly: `🥵 夯`, `😘 顶级`, `🤤 人上人`, `🫤 NPC`, `🤮 拉完了`. |
   | Long answer        | `你的点评（选填）`      | Optional. Placeholder: "分享你的整体用餐感受，比如口味、服务、环境或性价比……"                               |
   | File upload        | `照片（选填）`          | Optional; for photos that are not of one dish (room, menu). Multiple, max 10, 10 MB, images.                |
   | Text               |                         | Below the upload: "可上传餐厅环境、菜单等照片。"                                                            |
   | Divider            |                         |                                                                                                             |
   | Heading 2          |                         | "菜品点评（选填）"                                                                                          |
   | Text               |                         | "如果想单独评价某道菜，可以添加菜品点评，并上传对应照片。"                                                  |
   | Checkboxes         | `菜品1 添加`            | Optional, one unchecked option `＋ 添加一道菜`. Title cleared in the editor (see below).                    |
   | Short answer       | `菜品1 名称`            | **Required** (only while shown).                                                                            |
   | Multiple choice    | `菜品1 评价`            | **Required** (only while shown), nothing preselected. Options exactly: `🔥 推荐`, `💣 避雷`.                |
   | File upload        | `菜品1 照片（选填）`    | Optional; photos of this dish only. Multiple, max 3, 10 MB, images.                                         |
   | Short answer       | `菜品1 点评（选填）`    | Optional; one sentence about the dish.                                                                      |
   | (same five blocks) | `菜品2 …` to `菜品10 …` | Same settings and the same option `＋ 添加一道菜` (step 4).                                                 |
   | Divider            |                         |                                                                                                             |
   | Heading 2          |                         | "署名与授权"                                                                                                |
   | Short answer       | `署名（选填）`          | Optional; intake credits a blank name as 匿名.                                                              |
   | Text               |                         | Below it: "采用后会显示在网站上；不填则显示为「匿名」。"                                                    |
   | Email              | `联系邮箱（选填）`      | Optional.                                                                                                   |
   | Text               |                         | Below it: "只用于和你沟通，不会公开。"                                                                      |
   | Checkboxes         | `发布授权`              | Required, one unchecked option whose text starts with `我同意` (consent text below).                        |
   | Conditional logic  |                         | See step 4.                                                                                                 |
   | reCAPTCHA          |                         | Native spam protection.                                                                                     |
   | 'Thank you' page   |                         | Confirmation text (step 9).                                                                                 |

   Optional questions say so in their own title ("（选填）"); required ones
   use Tally's required setting only. Help text sits directly below the
   question it belongs to and does not repeat "选填". Intake matches titles by
   prefix, so `你的点评（选填）` and `菜品1 照片（选填）` are read like
   `你的点评` and `菜品1 照片` (exports of the older titles still work).

   Consent option text (`发布授权`); intake treats an answer starting with
   `我同意` as consent:

   > 我同意并确认：投稿基于真实用餐体验，内容真实、客观，不含虚假宣传、恶意贬损或未披露的商业推广及利益关系。
   > 我有权提交相关文字和照片，并授权 Rice Eats 经审核后按约定署名展示，以及在不歪曲原意的前提下进行必要编辑。
   > Rice Eats 保留独立审核及决定是否收录的权利，联系信息仅用于沟通，不对外公开。

   The `菜品N 添加` checkbox questions have an empty title, so contributors see
   only the option `＋ 添加一道菜` (the same for every dish; the next dish's
   questions are numbered `菜品2 …`), not a second label above it. Intake never reads these answers, and the conditional logic
   refers to the questions by id, so the empty titles change nothing else
   (the names above are how this document refers to them).

   In the form settings, set the language to Chinese (Simplified) so buttons
   and messages are in Chinese. The tooltip on a required question's asterisk
   ("必须") is Tally's built-in translation; the free plan cannot change it.

3. **Hidden fields.** The names must be exactly as in the table; the website
   passes only the non-empty ones as URL parameters, e.g.
   `?restaurant_name=...&restaurant_lat=29.717400&restaurant_lng=-95.401800&restaurant_address=...&poi_provider=geoapify&poi_id=...&selection_method=poi&source=site`.
   The form has no name question and does not repeat the name: the restaurant
   is chosen on the website, which shows it above the form (to change it,
   contributors use "更换餐厅" on the website). The
   fields are context, not proof: intake checks them against the database.
4. **Conditional logic** (Tally's conditional logic blocks):
   - Dishes are added one at a time, like entries on a résumé. The
     `菜品1 名称`, `评价`, `照片`, and `点评` questions are hidden by default
     and shown when `菜品1 添加` is checked. `菜品2 添加` is shown only when
     `菜品1 添加` is checked, and shows the `菜品2` questions; the same for
     `菜品3` to `菜品10`. Tally does not enforce required questions while they
     are hidden, so a dish's name and verdict are required only once the
     contributor adds that dish. Intake also reports dishes without a name or
     verdict, so a gap here never publishes anything.
   - The overall rating is required and the review text optional, so a
     submission may carry only a rating (plus consent). Intake accepts that
     as content; an invalid rating alone is blocked. Older submissions with
     text and no rating stay valid.
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

   > 投稿已收到，谢谢！Rice Eats 会先人工审核，审核通过后才会收录到网站上。
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

   The report also lists **review checks** for the editor (notes, never
   automatic rejections; `scripts/content/moderation.ts`): text that reads
   like promotion (deals, calls to action, links, phone numbers), hints of an
   undisclosed relationship with the restaurant (owner, staff, sponsorship,
   free meals), strong accusations (fraud, poisoning) that need support from
   the described experience, reviews nearly identical to another submission
   (in the export or imported earlier), and repeat reviews of one restaurant
   from the same email. Decide on these before drafting: ask the contributor
   to disclose a relationship, keep only supported claims, remove promotion,
   or reject. The consent statement asks for exactly this, but cannot enforce
   it on its own.

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

Automated tests use a stub instead of Tally (it posts the same
`Tally.FormLoaded` message), so the live integration must be
checked by hand once the form exists:

1. Open https://baoyunfan0101.github.io/rice-eats/ and use the "投稿" link.
   Check that named pins appear around Rice University without any action,
   click one, check the "已选餐厅" panel, use "下一步：填写点评 →", and submit
   a text-only test response.
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
   `source=site` for the others, and that the page showed the restaurant name above the form. Include a dish with a photo
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
