import type { Diagnostic, LoadedRestaurant } from './pipeline.ts';

export function printDiagnostics(diagnostics: Diagnostic[], log = console.error): void {
  for (const d of diagnostics) {
    const label = d.level === 'error' ? 'error  ' : d.draftError ? 'draft  ' : 'warning';
    log(`${label} ${d.file}: ${d.message}`);
  }
}

/** Optional information a maintainer may still want to collect, per restaurant. */
export function missingInfo(restaurant: LoadedRestaurant): string[] {
  const { info, review } = restaurant;
  const missing: string[] = [];
  if (!info.address) missing.push('address');
  if (!info.location) missing.push('location (not shown on the map)');
  if (!info.cuisines?.length) missing.push('cuisines');
  if (!info.neighborhood) missing.push('neighborhood');
  if (!info.summary) missing.push('summary');
  if (!info.cover) missing.push('cover image');
  if (!info.tier) missing.push('tier (optional rating)');
  if (info.pricePerPerson === undefined) missing.push('pricePerPerson (optional)');
  if (!review?.trim() && !info.dishes?.length) missing.push('review.md or dishes');
  if (!info.contributors?.length) missing.push('contributors (required to publish)');
  return missing;
}
