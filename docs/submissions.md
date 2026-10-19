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
- **Keywords** are a question of the form itself (`标签（选填）`, below the
  review): contributors type free-form words separated by commas (`，` `,`)
  or `、` ("适合约会，很安静、份量大"). Intake splits the answer
  (`parseList` in `shared/submission.ts`, which also accepts semicolons
  and new lines), keeps spaces inside a keyword ("date night"), and drops
  repeats (ignoring width, case, and spacing).
- **Restaurant aliases** are another question (`餐厅别名（选填）`, below the
  tags): other names of the restaurant (an English name, a short name),
  split the same way. Prepare adds the new ones to the draft's `altNames`
  (never replacing its name; a rejection takes them out again); they are
  not used to decide which restaurant a submission is about.
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
- **Finding the restaurant** (`src/views/MapSearch.tsx`, `src/lib/areas.ts`,
  `src/lib/geocode.ts`): step 1 is one box, "选择餐厅", under the page title
  and the step. At its top are one search box ("搜索餐厅名称或地址") and the
  map shortcuts: "使用当前位置" first and highlighted (the browser asks only
  after that click, never on load; a denial leaves the other ways), then
  "Rice University 周边" and "Chinatown 周边" (Bellaire Blvd in southwest
  Houston, between Dun Huang Plaza and Hong Kong City Mall; static
  coordinates, no request), and "上次的位置" when this browser remembers
  where the contributor last went on to the form (the map view, rounded to
  about 100 m, in `localStorage` only; never sent anywhere). Typing narrows
  the pins and the list to the names that match, in view (no request).
  "搜索" (or Enter) also searches beyond the map and shows two groups:
  **餐厅**, the matching restaurants on Rice Eats (anywhere) and places to
  eat found by Geoapify Geocoding (a result of type `amenity` in a
  `catering` category or with a food amenity), chosen directly with one
  click; and **地址或地点**, every other result, which only moves the map so
  the contributor picks from the pins there. A single place moves the map at
  once; a failed search offers "重试", and the shortcuts, the map, and
  manual entry keep working. Without a Geoapify key, only restaurants on
  Rice Eats are found by name. The last request wins: each action (a
  shortcut, "使用当前位置", a search, choosing a result, choosing a
  restaurant, placing a manual marker, or dragging or zooming the map by
  hand) cancels the pending search and makes any older answer, including a
  late device location or a late error, change nothing, so the map always
  ends where the contributor last asked for. Hand moves are recognized from
  their input (`src/views/PickerMap.tsx`: Leaflet's `dragstart`, the wheel, a
  double click, a two-finger touch, the zoom buttons, and the map's keys),
  never from `moveend`/`zoomend`, which programmatic `setView` calls (a
  shortcut, a search result, a selection, restoring the view) also fire; the
  search, the shortcuts, and the map share one `LocateIntent`
  (`src/lib/locateIntent.ts`). Moving the map never selects a restaurant.
- **Restaurant selection** (`src/views/RestaurantSelector.tsx`,
  `src/views/PickerMap.tsx`, `src/lib/poi.ts`) is map-first. The map opens on
  Rice University and shows the restaurants in view as pins labelled with the
  restaurant name: restaurants already on Rice Eats as green pins ("已收录";
  choosing one is like starting from its restaurant page:
  `selection_method=existing` with its `restaurant_id`), and restaurants,
  fast food, cafes, and food courts from the
  [Geoapify Places API](https://apidocs.geoapify.com/docs/places/) as the
  usual pins (a place within 100 m of a listed restaurant with the same name
  or other name shows once, as the listed one). Clicking a pin (or its name)
  selects that restaurant. Labels (`src/lib/labelLayout.ts`) go on the right of a pin, or
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
  - While a name is typed, the list opens by itself and shows the
    restaurants in view whose name (or other name) contains the text, so the
    list is always the map's area AND the name. Choosing a restaurant clears
    the search. The selected restaurant with "下一步：填写点评 →" closes the
    page, below the box and the data-source line. If the place is missing,
    "找不到？手动添加餐厅" takes the 餐厅名称 and a map marker (drawn like a
    selected restaurant pin, with the name beside it); a name alone
    ("我不确定具体位置") is allowed and is marked for location verification.
    Manual entry has the same search box (addresses and places only) and
    shortcuts, but no restaurant pins. A searched or shortcut location is
    never the restaurant's location: only the contributor's marker is, or a
    searched place after "用这个地点作为餐厅位置" (whose address is then sent;
    there is no separate address field).
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
  a private draft with a review report (`prepare`), and waits for the
  maintainer's approval.

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
   | Short answer       | `标签（选填）`          | Optional. Placeholder: "例如：适合约会，适合聚餐".                                                          |
   | Text               |                         | Below it: "用几个词描述这家店，多个标签用逗号（，）或顿号（、）分开。"                                      |
   | Short answer       | `餐厅别名（选填）`      | Optional. Placeholder: "例如：英文名、简称".                                                                |
   | Text               |                         | Below it: "这家店的其他名字，多个用逗号（，）或顿号（、）分开。"                                            |
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
   `你的点评` and `菜品1 照片`.

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
   - The overall rating is required and everything else optional, so a
     submission may carry only a rating (plus consent). Intake blocks a
     submission without a valid rating.
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
   `private/submissions/tally-<submission id>/` for good (see
   [Retention](#retention-and-backup)), records the id in the private log
   `private/submissions/tally-log.json` (so it is never imported twice), and
   reports the restaurant match,
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
   `restaurant_id` (a different name, even close by, or a distant location is a
   conflict for the maintainer), then a
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
4. Prepare the draft (see [Prepare](#prepare)):

   ```sh
   npm run content:submission -- prepare <submission id>
   ```

   Then read the review report it prints (also saved privately as
   `review-report.md`), settle its open items, and run it again. The
   `restaurant-intake` Skill can do the judgment steps (tag decisions,
   checking restaurant information) and run it for you.

5. Review and approve as usual (`content:promote`, `content:publish`). Then
   record the outcome (prepare records `drafted` itself):

   ```sh
   npm run content:submission -- mark <submission id> --status processed --id <restaurant id>
   npm run content:submission -- mark <submission id> --status rejected
   ```

   The raw submission is kept whatever the status. Rejecting a submission
   takes its contribution back out of the draft (see
   [Rejecting](#rejecting-a-submission)).

### Prepare

`content:submission -- prepare <submission id>` turns one stored submission
into a private draft with no manual field mapping
(`scripts/content/prepare.ts`). It never promotes, publishes, commits, or
touches `content/`, and it can be run again at any time.

- **Blocked** (exit code 1, nothing written) without consent or a valid
  rating, for a rejected
  submission, while photos are unresolved (pending or failed; recover or
  waive them first), when the display name looks like contact details, or
  when the restaurant is uncertain: give `--id <restaurant id>` for an
  existing restaurant or `--new` for a new one. The decision is remembered.
- **Restaurant**: an id passed by the website and checked, a POI linked by an
  earlier reviewed submission, or a unique nearby restaurant with the same
  name is used automatically; same-name restaurants farther away are other
  branches, never merged.
- **Contributor**: reused only for the same email address, never for a
  name alone; a submission without an email gets its own contributor (with a
  note when the name is already taken), and anonymous and named submissions
  are never merged.
- **Every submission is a review of its own**: `reviews/<review id>.json`
  (contributor, submission time, rating, dish verdicts and comments, photos)
  and `.md` (the text), with only this submission's content. Its review id is
  generated on the first prepare and kept in `prepare.json`, so a rerun
  rewrites the same review and never adds a second one; another submission,
  even by the same contributor with the same words, always gets its own.
  No review is ever changed by another submission. The submission time is
  Tally's "Submitted at" (UTC), so reviews of one day still have an order.
- **Dishes**: a dish name (or one of its `altNames`, ignoring width, case,
  and spacing) that the restaurant already has is that dish; any other name
  becomes a new dish (`d1`, `d2`, …) in `info.json`. To merge two dishes,
  move one's verdicts to the other's id and add its name to `altNames`.
- **Draft**: the review, named dishes, keywords mapped to tags, restaurant
  information (below), and the contributor. Photos are
  standardized in slot order (metadata removed) and imported once each by
  content hash, so a rerun or a recovered photo never creates a second copy.
  Values already in the draft or the public record are never overwritten; a
  different value is reported as a conflict.
- **Shared restaurant information**: tags, other names, cuisines, facts,
  and dishes in `info.json` are shared by every review. `prepare.json`
  records what each run itself added, and when (`owned`), and what the
  submission gives whoever added it (`claims`); equal values elsewhere are
  never taken as its own.
- **Idempotent and recoverable**: progress is kept in `prepare.json` next to
  the submission; an interrupted run continues where it stopped, and a run
  with nothing new reports `unchanged`. A draft edited by hand since the last
  run (its review files or photos) is left alone (`--rebuild` builds the
  contributor's review again from the submission). A deleted draft is recreated.
- **Photos of a rebuilt draft**: each stored image is linked to its photo
  number and content hash. When a photo no longer belongs to the submission
  (its file changed and was added again, or it was waived), the image an
  earlier run imported for it is removed; a replaced photo keeps its image
  number, so the order and the cover stay. Repeated runs never duplicate an
  image. Images added by hand (`content:add-images`) are never removed: the
  report lists them, since an image no review uses appears in the gallery.
- **Report**: content and photos, each keyword and its tag, each piece of
  restaurant information with its source, method, and confidence, conflicts,
  privacy and consent findings (contact details in the text are flagged and
  must be removed before promotion, which refuses them), blockers, what is
  still missing, the `content:check` result, and which public files promotion
  would change (new tags and contributor names included).

### Rejecting a submission

```sh
npm run content:submission -- mark <submission id> --status rejected
```

The raw submission stays in `private/submissions/` (rejection never deletes
it). Its contribution is taken back out of the draft, using what
`prepare.json` recorded: its review id, a fingerprint of the review and
photos as prepare last wrote them, and what the submission itself added to
`info.json` (`owned`: each run records only what it added, never what other
submissions or the maintainer added in between, so preparing it again never
widens what it owns):

- its own review goes, but only while it is exactly what the submission
  wrote. Other reviews are never touched, whoever wrote them and whatever
  they say, and no review is ever put back: when a contributor's latest
  review goes, their previous one simply counts for the rating again;
- what it added to `info.json` goes where it is still as written, unless
  another submission still in the draft added it later (say the maintainer
  removed a tag after A and B added it again) or gives it too: that one
  owns it from then on, so rejecting it later takes it out. A dish also
  stays while another review rates it. A field changed since is a conflict
  (below);
- images the submission stored, at the path it stored them and unchanged,
  are removed, unless another review uses them; images that were there
  before or were added by hand stay (a copy with the same content is not
  taken as its own);
- a draft folder that prepare created (for this or another submission) is
  removed when nothing else is left in it (no review, no other submission,
  no other information or photo; for a checked-out restaurant, nothing that
  differs from the public one); a restaurant's
  earlier draft (`content:new`, `content:edit`) keeps
  everything that did not come from the submission;
- tags the submission proposed are withdrawn from `private/tags.json` unless
  another draft uses them. The contributor stays in
  `private/contributors.json` (a record), but no draft credits them.

A restaurant that was already promoted is not changed; edit it with
`content:edit`.

**The publication block.** The rollback has its own state in `prepare.json`
(`rejection.status`: `pending` while it runs, `manual` when it needs the
maintainer, then `done` or `resolved`), separate from the editorial status
in `tally-log.json`. Until it is `done` or `resolved`, `mark` refuses every
other status, `prepare` refuses the submission, and `content:check` and
`content:promote` (also with `--approved`) fail for that restaurant's draft,
whatever the log says. This happens when:

- something the submission wrote was changed since: its review (text, data,
  or photos) edited by hand; a field of `info.json` it filled (say the maintainer corrected the address it
  gave); a dish it added; or another review now uses one of its photos.
  Nothing is changed and the command exits with code 1 listing them. Remove
  the submission's content from them (or put back what was there before) and
  run it again, or, after checking them, keep their current content with
  `--resolved` (a kept review keeps every photo it uses);
- the command was interrupted (the state is written before the log): run it
  again, which is always safe;
- `prepare.json` cannot be read, or is missing although the log shows the
  submission wrote into a draft (`draftWritten`, cleared by a finished
  rejection; a submission that was never prepared is rejected normally).
  Restore `private/submissions/tally-<id>/` from the
  [backup](#retention-and-backup) and run the command again. Without a
  backup, check the draft by hand (remove what came from the submission, keep
  only what has its own source) and confirm it; the note is recorded with the
  time in the log entry's `audit`:

  ```sh
  npm run content:submission -- mark <submission id> --status rejected --state-lost "removed its review, dishes, and photos"
  ```

`--resolved` and `--state-lost` are accepted only with `--status rejected`;
`--state-lost` only for lost state, and with a note.

### Keywords and tags

Each keyword is matched to a [tag](content.md#tags) deterministically: a
tag's id, label, or alias (ignoring width, case, spacing, and punctuation),
then an alias learned from an earlier reviewed decision. Other keywords stay
pending in the report until a decision is written to the submission's
`resolutions.json` (private), by the maintainer or by the agent with the
`restaurant-intake` Skill:

```json
{
  "tags": [
    { "keyword": "很安静", "tag": "study" },
    { "keyword": "份量大", "newTag": { "id": "big-portions", "label": "份量大" } },
    { "keyword": "我朋友推荐的", "skip": "not about the restaurant" }
  ],
  "facts": []
}
```

The file is validated: keywords must be the contributor's own, tags must
exist, and new ids are slugs. Tag labels become public on every restaurant
that uses them, so a new tag's id and label (also one a model proposed) are
checked for contact details (`scripts/content/privacy.ts`): email addresses,
`@` handles, links and domains, phone numbers, a messaging or social-media
word with an id (`vx abc123`, `QQ: …`), and token-like strings are never
used; a contact word on its own (`微信支付`), a long number, or a handle-like
word is reported for review. The same check runs on `content/tags.json` (ids,
labels, aliases) in `content:check`, the build, `npm run check:privacy`, and
`content:promote`, which refuses such a tag. A decision is
remembered as a private alias (`private/tags.json`), so the same word needs
no decision next time; a new tag is proposed privately and becomes public
(id and label only) when a restaurant using it is promoted. The raw keywords
and their mapping never leave `private/`. Without decisions the draft is still
built; pending keywords are just not tags yet.

### Restaurant information

Prepare fills empty `altNames`, `address`, `cuisines`, and `links.website`
from the map listing the contributor chose: Geoapify place details when
`GEOAPIFY_API_KEY` (a server-side key without the website's origin
restriction) is set in `.env.local`, otherwise OpenStreetMap through Overpass
(by id, or a place with the same name within 60 m). Lookups are cached in
`private/cache/` (`--refresh` looks again, `--offline` uses the cache only);
a failure is reported and never blocks the draft.

The POI id is a hidden form field, so the listing is checked before anything
from it is used. It is compared with the restaurant: an existing
restaurant's own record (name, other names, location, address), otherwise the
submission's name, location, and address.

| Result      | When                                                                                                                                                                                                                                                                                                  | Information   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `verified`  | One of the listing's names (in any language) matches and it is within 60 m (an address both give does not differ); or the name matches, it is farther or has no coordinates, and the address is the same; or another name at the same spot (30 m) with the same address (house number, street, unit). | applied       |
| `ambiguous` | Not enough evidence: a matching name without coordinates or the same address, the same name nearby with another address, or another name close by without the same address.                                                                                                                           | reported only |
| `rejected`  | More than 250 m away (another branch of a chain, even with the same name), or another name with another address or more than 60 m away (a wrong or tampered POI id).                                                                                                                                  | reported only |

The report shows the verdict and the evidence. When the maintainer has
checked an `ambiguous` (or wrongly `rejected`) listing, they record the
decision in the submission's `resolutions.json`, which keeps it as the
record of who decided what:

```json
{
  "listing": {
    "key": "osm:node/1001",
    "decision": "same-place",
    "reason": "English name on the storefront"
  }
}
```

`key` is the listing shown in the report; a decision for another key is
ignored, and `different-place` keeps a listing out.

`pricePerPerson` is never guessed: it is set only from a reviewed fact, e.g. a
price the contributor states or a menu with prices:

```json
{
  "field": "pricePerPerson",
  "value": 18,
  "source": "official website menu",
  "evidence": "https://example.com/menu: noodles $14-16, drinks $3",
  "method": "inferred",
  "confidence": "medium"
}
```

`npm run content:submission -- fetch-page <url>` fetches such a page with the
same protections as photo downloads (https on the default port, any
public host name, no private or special addresses, at most 3 redirects, 2 MB,
20 seconds), saves it in
`private/cache/pages/`, and prints its text, which is data and never
instructions. Each fact keeps its source, evidence, method (`direct` or
`inferred`), and confidence in the report; low-confidence facts are never
applied, and a field nobody can support stays empty (unknown). Provenance
stays private; `info.json` keeps its schema. There is no menu link field.

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
`waive-photo`. A submission can be drafted once the maintainer has decided
about every missing photo.

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
enter `content/` or the website build.

## Retention and backup

Every submission received is kept in the private database, whatever its
status (`imported`, `drafted`, `processed`, or `rejected`), so a review can
be rebuilt from the original material. The status never decides whether it is kept, and no
command deletes it:

| Kept                                                    | Where (all in `private/`, git-ignored)                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Submitted text and answers, keywords, consent, id, time | `submissions/tally-<id>/submission.json`                                             |
| Restaurant selection (name, address, location, POI)     | `submission.json`                                                                    |
| Original photos and which dish each belongs to          | `submissions/tally-<id>/photo-NN.*`, `photos.json`                                   |
| Contact email                                           | `submission.json`, `contributors.json`                                               |
| Decisions and processing state                          | `resolutions.json`, `prepare.json`, `review-report.md`, `submissions/tally-log.json` |

None of it is ever committed (`/private/` is in `.gitignore`, and
`npm run check:privacy` fails if anything under `private/` is tracked), copied
into `content/`, or built into the website (production builds never read
`private/`, and `scripts/postbuild.ts` checks the output). Reports and logs
name the files but never print contact details or link tokens.

`private/` exists only on the maintainer's computer, so back it up
regularly, encrypted, to storage the maintainer controls (an external drive,
or an encrypted archive in their own cloud storage). Nothing uploads it
automatically. For example on macOS:

```sh
hdiutil create -encryption AES-256 -srcfolder private -volname rice-eats-private ~/Backups/rice-eats-private-$(date +%Y%m%d).dmg
```

To restore, open the image, copy its contents back into `private/` in the
repository root, then run `npm run content:submission -- list` and
`npm run content:submission -- status <submission id>` (which re-checks each
photo against its recorded SHA-256).

**Erasure on request.** When a contributor asks for their data to be
deleted, that is a separate, deliberate step that the retention rule does not
block: remove `private/submissions/tally-<id>/`, their entry in
`private/contributors.json` (and their name in `content/contributors.json` and
their content in `content/` if it was published, as the maintainer decides),
and the copies in backups. The log entry (id, status, restaurant, and POI
link) stays, so the export is not imported again (import reports it as
`missing`); remove that entry too if the request covers it.

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
   restaurant by name with "搜索" (one beyond the map), choose it from the
   "餐厅" results, and submit a photo-only test response. Search an address
   and check that it only moves the map. Then deny the location permission
   once and check that the message appears and the map still works. Reload
   the page and check that "上次的位置" returns to where the last restaurant
   was chosen.
3. Add a restaurant by hand (name and marker) and submit a test response.
4. On a restaurant page, use "补充点评或照片" and submit a test response.
5. In Tally, confirm the responses recorded `restaurant_name`,
   `restaurant_lat` / `restaurant_lng`, `selection_method` (`poi`, `poi`,
   `manual`, `existing`), `poi_provider` / `poi_id` for the first two,
   `restaurant_id` and `source=restaurant-page` for the fourth, and
   `source=site` for the others, and that the page showed the restaurant name above the form.
   Answer `标签（选填）` in one response (see the checklist below); the
   others leave it empty. Include a dish with a photo
   in one response and check that the import lists the photo under that dish.
6. Confirm three notification emails arrived at `hello.riceeats@gmail.com`.
7. Export the CSV, run `npm run content:submission -- import`, and confirm the
   photos were downloaded (`photos: complete`). If Tally serves them from a
   host outside the trusted list, note the host, recover the photos with
   `add-photo`, and review the list.
8. Run `npm run content:submission -- prepare <id>` for the response with
   keywords, check the report (the keywords and their tags), and check the
   draft with `npm run content:check`.
9. Confirm `git status` shows no changes in `content/` and nothing under
   `private/` is tracked. Then mark the test submissions `rejected`. They are
   the maintainer's own test data, so deleting them in Tally and removing
   their folders in `private/` afterwards is an explicit erasure (see
   [Retention](#retention-and-backup)), not a cleanup that happens on its own.

### Tags and aliases in the live form

The automated tests use a stub instead of Tally, so check the tag and
alias questions in the real form once (and after changing it), and record the
result; until then it is not verified. For each answer, check the CSV
column `标签（选填）` and the keywords in the report of `import` and
`prepare`:

| #   | Answer                                         | Expect                                               |
| --- | ---------------------------------------------- | ---------------------------------------------------- |
| 1   | `适合约会，很安静、份量大` (typed with pinyin) | three keywords: `适合约会`, `很安静`, `份量大`       |
| 2   | `date night, quiet`                            | `date night` (space kept) and `quiet`                |
| 3   | (empty)                                        | no keywords, no error                                |
| 4   | `安静，安静、ＱＵＩＥＴ、quiet`                | `安静` and `ＱＵＩＥＴ` once each (repeats dropped)  |
| 5   | the same answer through "在新窗口打开投稿表单" | the same keywords and restaurant fields as the embed |
| 6   | `餐厅别名（选填）`: `Example House、小汤包`    | the draft's `altNames` gains both                    |

The CSV headers must start with `标签` and `餐厅别名` (`TALLY_QUESTIONS` in
`shared/submission.ts`).
