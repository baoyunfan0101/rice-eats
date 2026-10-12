import type { Diagnostic, LoadedRestaurant } from './pipeline.ts';

export function printDiagnostics(diagnostics: Diagnostic[], log = console.error): void {
  for (const d of diagnostics) {
    const label = d.level === 'error' ? 'error  ' : d.draftError ? 'draft  ' : 'warning';
    log(`${label} ${d.file}: ${d.message}`);
  }
}

/**
 * Information a maintainer may still want to collect, per restaurant. Only
 * contributorIds is required (to publish); everything else is optional and
 * must not be invented to fill this list.
 */
export function missingInfo(restaurant: LoadedRestaurant): string[] {
  const { info } = restaurant;
  const missing: string[] = [];
  if (!info.contributorIds?.length) missing.push('contributorIds (required to publish)');
  if (!info.address) missing.push('address');
  if (!info.location) missing.push('location (not shown on the map)');
  if (!info.cuisines?.length) missing.push('cuisines');
  if (restaurant.images.length === 0) missing.push('images (no cover)');
  return missing;
}
