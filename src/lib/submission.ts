// Website side of the Tally submission form (docs/submissions.md). The form
// is configured once in site.config.ts; without a valid setting every
// submission link is hidden, so the site never shows a broken entry point.

import { parseTallyForm } from '../../shared/submission';

/** The configured Tally form id, or undefined when submissions are not set up. */
export function submissionFormId(): string | undefined {
  const setting = parseTallyForm(import.meta.env.VITE_TALLY_FORM);
  return setting.status === 'ok' ? setting.formId : undefined;
}

export { tallyUrls, type SubmissionContext } from '../../shared/submission';
