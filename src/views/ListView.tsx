import type { RestaurantSummary } from '../content/model';
import { DraftBadge, Tags, TierBadge } from '../components/Badges';
import { Link } from '../components/Link';
import { RestaurantImage } from '../components/RestaurantImage';
import { metaLine } from '../lib/format';
import { restaurantHref } from '../lib/router';

export function ListView({ restaurants }: { restaurants: RestaurantSummary[] }) {
  return (
    <ul className="mx-auto w-full max-w-6xl divide-y divide-line px-4 py-2" aria-label="餐厅列表">
      {restaurants.map((r) => (
        <li key={r.id}>
          <Link
            href={restaurantHref(r.id)}
            className="group -mx-2 flex gap-4 rounded-xl px-2 py-4 hover:bg-white sm:gap-5"
          >
            <RestaurantImage
              decorative
              image={r.cover}
              sizes="(min-width: 640px) 160px, 96px"
              className="aspect-square w-24 shrink-0 rounded-lg sm:aspect-[4/3] sm:w-40"
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold leading-snug group-hover:text-chili-700">
                  {r.name}
                </h2>
                <TierBadge tier={r.tier} />
                {r.status === 'draft' && <DraftBadge />}
              </div>
              {r.altNames.length > 0 && (
                <p className="text-sm text-muted">{r.altNames.join(' / ')}</p>
              )}
              <p className="text-sm font-medium text-ink/80">{metaLine(r)}</p>
              {r.summary && (
                <p className="line-clamp-2 text-sm leading-6 text-muted">{r.summary}</p>
              )}
              {r.address && <p className="hidden text-xs text-muted sm:block">{r.address}</p>}
              <Tags tags={r.tags} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
