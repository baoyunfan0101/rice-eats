# Public submissions (Tally)

Visitors can send a review, photos, or both through a hosted
[Tally](https://tally.so) form, without GitHub or an account. Nothing they
send is published automatically:

```text
Rice Eats website -> Tally form -> Gmail notification -> local intake (Agent)
  -> human review -> content/ (database) -> static website
```

- **Website** (`src/`): a "投稿" link in the header, a "补充点评或照片" box on
  each restaurant page, and the submission page `/rice-eats/submit/` with the
  embedded form and a direct link to the Tally-hosted form. The form loads only
  on that page. The website never writes to the database.
- **Tally**: collects the text, photos, rating, credit, contact email, and
  consent. Free-plan features only.
- **Gmail** (`hello.riceeats@gmail.com`): receives a notification per
  submission. It is a queue, not a database.
- **Local intake** (`npm run content:submission`, the `restaurant-intake`
  Skill): copies a submission into the git-ignored `private/` folder, prepares
  a private draft, and waits for the maintainer's approval.

The shared contract (hidden-field names, question titles, rating options, the
form setting) is defined once in `shared/submission.ts`.

## Maintainer setup (one time)

These steps happen in the maintainer's Tally and Gmail accounts; no agent has
access to them. Menu names may differ slightly in Tally's editor.

1. **Account.** Sign in to Tally with `hello.riceeats@gmail.com` (create the
   account if needed). The notification emails go to the account's address.
2. **Create a form**, e.g. "Rice吃啥 投稿", with these blocks in this order.
   Keep the question titles exactly as written (intake finds answers in the CSV
   export by these titles, defined in `shared/submission.ts`):

   | Block                 | Title / name           | Settings                                                                                     |
   | --------------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
   | Hidden fields         | `restaurant_id`        | Filled in by the website on restaurant pages.                                                |
   |                       | `restaurant_name_zh`   | The restaurant's Chinese name, when it has one.                                              |
   |                       | `restaurant_name_en`   | The restaurant's English name, when it has one.                                              |
   |                       | `source`               | `site` or `restaurant-page`.                                                                 |
   | Text                  |                        | Intro only: listed or new restaurants; manual review, no guaranteed publication.             |
   | Short answer          | `餐厅中文名`           | Optional; default answer `@restaurant_name_zh`; placeholder "中文名和英文名至少填一个".      |
   | Short answer          | `餐厅英文名`           | Optional; default answer `@restaurant_name_en`; placeholder "招牌或地图上的英文名".          |
   | Text                  |                        | "下面的点评、推荐/避雷的菜、照片至少填一项，其余都是选填。"                                  |
   | Long answer           | `你的点评`             | Optional. Placeholder: "随便写，口味、环境、推荐或踩雷的菜都可以。"                          |
   | Text                  |                        | "这里传环境、菜单等不属于某道菜的照片；某道菜的照片请传在下面对应的菜品里。"                 |
   | File upload           | `照片`                 | Optional; for photos that are not of one dish (room, menu). Multiple, max 10, 10 MB, images. |
   | Text                  |                        | "推荐或避雷的菜（选填，最多 5 道）：每道菜的照片请传在这道菜下面；填好菜名后会出现下一道。"  |
   | Short answer          | `菜品1 名称`           | Optional.                                                                                    |
   | Multiple choice       | `菜品1 评价`           | Optional, nothing preselected. Options exactly: `推荐`, `避雷`, `不评价`.                    |
   | File upload           | `菜品1 照片`           | Optional; photos of this dish only. Multiple, max 3, 10 MB, images.                          |
   | Short answer          | `菜品1 点评`           | Optional; one sentence about the dish.                                                       |
   | (same four questions) | `菜品2 …` to `菜品5 …` | Same settings; each group is shown only when the previous dish has a name (step 4).          |
   | Multiple choice       | `总体评级`             | Optional, nothing preselected. Options exactly: `夯`, `顶级`, `人上人`, `NPC`, `拉完了`.     |
   | Short answer          | `署名`                 | Optional. Placeholder: "采用后会显示在网站上；可写「匿名」"                                  |
   | Email                 | `联系邮箱`             | Optional. Placeholder: "只用于和你沟通，不会公开"                                            |
   | Checkboxes            | `发布授权`             | Required, one unchecked option whose text starts with `我同意` (consent text below).         |
   | Conditional logic     |                        | See step 4.                                                                                  |
   | reCAPTCHA             |                        | Native spam protection.                                                                      |
   | 'Thank you' page      |                        | Confirmation text (step 9).                                                                  |

   Consent option text (`发布授权`); intake treats an answer starting with
   `我同意` as consent:

   > 我同意：我有权提交这些文字和照片（文字由我撰写，照片由我拍摄或已获授权），并授权 Rice吃啥
   > 审核；审核通过后可按约定的署名在网站上复制和展示。我了解投稿不保证发布，内容可能为统一格式而编辑
   > 但不会歪曲我的观点，联系方式不会公开显示。

   In the form settings, set the language to Chinese (Simplified) so buttons
   and messages are in Chinese.

3. **Hidden fields.** The names must be exactly `restaurant_id`,
   `restaurant_name_zh`, `restaurant_name_en`, and `source`; the website
   passes them as URL parameters
   (`?restaurant_id=r-abc123&restaurant_name_zh=...&restaurant_name_en=...&source=restaurant-page`).
   The name questions default to them, so visitors from a restaurant page see
   the names filled in and can correct them. They are context, not proof:
   intake checks them against the database.
4. **Conditional logic** (Tally's conditional logic blocks):
   - At least one name: when `餐厅中文名` **and** `餐厅英文名` are empty,
     require `餐厅中文名`.
   - Something to review: when `你的点评`, `照片`, and `菜品1 名称` are all
     empty, require `你的点评`.
   - Dish groups: show the `菜品2` questions only when `菜品1 名称` is not
     empty (hide them by default), and the same for `菜品3` to `菜品5`.
     Intake also reports or rejects submissions without a name or content, so a
     gap here never publishes anything.
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
12. **Verify end to end** with the checklist below.

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
     "restaurantNameZh": "示例拉面",
     "restaurantNameEn": "Example Noodles",
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

3. Check that the photo intake is complete, and recover missing photos (see
   [Photos](#photos) below).
4. Ask the agent to process the imported submission with the
   `restaurant-intake` Skill. It prepares a private draft (or proposes changes
   to an existing restaurant's single review), and reports what it did.
5. Review and approve as usual (`content:promote`, `content:publish`). Then
   record the outcome:

   ```sh
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
2. Submit a text-only test response.
3. Submit a photo-only test response.
4. On a restaurant page, use "补充点评或照片" and submit a test response.
5. In Tally, confirm the third response recorded `restaurant_id`,
   `restaurant_name_zh` / `restaurant_name_en`, and `source=restaurant-page`,
   and that the first two recorded `source=site`. Include a dish with a photo
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
