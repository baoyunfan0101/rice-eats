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
   export by these titles):

   | Block                                  | Title / name      | Settings                                                                                 |
   | -------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
   | Hidden fields                          | `restaurant_id`   | Filled in by the website on restaurant pages.                                            |
   |                                        | `restaurant_name` | Filled in by the website on restaurant pages.                                            |
   |                                        | `source`          | `site` or `restaurant-page`.                                                             |
   | Short answer                           | `餐厅名称`        | Required. Conditional logic: hide it when `restaurant_id` is not empty (see step 4).     |
   | Long answer                            | `你的点评`        | Optional. Help text: "随便写，口味、环境、推荐或踩雷的菜都可以。"                        |
   | File upload                            | `照片`            | Optional. Multiple files, at most 10, images only, at most 10 MB each.                   |
   | Multiple choice                        | `总体评级`        | Optional, nothing preselected. Options exactly: `夯`, `顶级`, `人上人`, `NPC`, `拉完了`. |
   | Short answer                           | `署名`            | Optional. Help text below.                                                               |
   | Email                                  | `联系邮箱`        | Optional. Help text below.                                                               |
   | Checkboxes                             | `发布授权`        | Required, one option `我同意`, not preselected. Consent text below.                      |
   | Captcha (reCAPTCHA) or spam protection |                   | Turn on whichever native spam protection the form offers.                                |

   On restaurant pages, add a text block above the questions that mentions the
   `restaurant_name` hidden field (type `@` and pick it), e.g. "你正在为
   @restaurant_name 投稿", and show it only when `restaurant_id` is not empty.

   Help text for `署名`: "如果投稿被采用，这个名字会显示在网站上。留空则由编辑和你确认署名方式，也可以写「匿名」。"

   Help text for `联系邮箱`: "只用于就投稿和你联系，不会公开显示。"

   Consent text (`发布授权`, shown above the option):

   > 我确认自己有权提交这些文字和照片（文字由我撰写，照片由我拍摄或已获授权），并授权
   > Rice吃啥 审核；审核通过后，Rice吃啥 可以按约定的署名在网站上复制和展示这些内容。
   > 我了解投稿不保证一定发布，内容可能为统一格式而编辑，但不会歪曲我的观点；联系方式不会公开显示。

3. **Hidden fields.** The names must be exactly `restaurant_id`,
   `restaurant_name`, and `source`; the website passes them as URL parameters
   (`?restaurant_id=r-abc123&restaurant_name=...&source=restaurant-page`).
   They are context, not proof: intake checks them against the database.
4. **Conditional logic.**
   - `restaurant_id` is empty -> show `餐厅名称` (hidden otherwise), so general
     submissions must name the restaurant and restaurant pages do not ask again.
   - Prevent empty submissions: when `你的点评` is empty **and** `照片` has no
     file, require an answer to `你的点评` (Tally's "require answer" action),
     or show a required warning question if that action is not available.
     Intake also rejects empty submissions, so a gap here never publishes
     anything.
5. **Photos.** In the file upload block, allow multiple files, limit to 10
   files and 10 MB per file (the free-plan maximum), and accept images. HEIC
   from iPhones is fine: intake converts it.
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
     "restaurantName": "Example Noodles",
     "review": "…",
     "ratingAnswer": "顶级",
     "photoUrls": ["https://storage.tally.so/…"],
     "displayName": "小明",
     "email": "…",
     "consent": true
   }
   ```

2. Import it:

   ```sh
   npm run content:submission -- import private/tally-export.csv
   ```

   For each submission this stores `submission.json` and the downloaded
   photos in `private/submissions/tally-<submission id>/`, records the id in
   the private log `private/submissions/tally-log.json` (so it is never
   processed twice, even after the files are deleted), and reports the
   restaurant match, rating, credit, consent, and problems. Photos are
   downloaded only from `https://*.tally.so` links, at most 10 per submission
   and 10 MB each, and kept only if they are real images. If a link has
   expired or needs the Tally login, download the photo from the dashboard
   into the same folder. Submissions without consent or content are marked
   BLOCKED. The command creates no drafts and changes nothing in `content/`.

3. Ask the agent to process the imported submission with the
   `restaurant-intake` Skill. It prepares a private draft (or proposes changes
   to an existing restaurant's single review), and reports what it did.
4. Review and approve as usual (`content:promote`, `content:publish`). Then
   record the outcome:

   ```sh
   npm run content:submission -- mark <submission id> --status processed --id <restaurant id>
   npm run content:submission -- mark <submission id> --status rejected
   ```

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
   `restaurant_name`, and `source=restaurant-page`, and that the first two
   recorded `source=site`.
6. Confirm three notification emails arrived at `hello.riceeats@gmail.com`.
7. Export the CSV, run `npm run content:submission -- import`, and confirm the
   photos were downloaded (or can be downloaded from the dashboard).
8. Ask the agent to prepare a private draft from one test submission and
   check it with `npm run content:check`.
9. Confirm `git status` shows no changes in `content/` and nothing under
   `private/` is tracked. Then delete the test submissions in Tally and the
   test folders in `private/`, and mark them `rejected`.
