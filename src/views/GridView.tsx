import type { RestaurantSummary } from '../content/model';
import { DraftBadge, TierBadge } from '../components/Badges';
import { Link } from '../components/Link';
import { RestaurantImage } from '../components/RestaurantImage';
import { metaLine } from '../lib/format';
import { restaurantHref } from '../lib/router';

export function GridView({ restaurants }: { restaurants: RestaurantSummary[] }) {
  return (
    <ul
      className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-5 px-4 py-6 min-[480px]:grid-cols-2 lg:grid-cols-3"
      aria-label="餐厅网格"
    >
      {restaurants.map((r) => (
        <li key={r.id}>
          <Link
            href={restaurantHref(r.id)}
            className="group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="relative">
              <RestaurantImage
                decorative
                image={r.cover}
                sizes="(min-width: 1024px) 360px, (min-width: 480px) 50vw, 100vw"
                className="aspect-[4/3] w-full transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none"
              />
              <div className="absolute top-3 left-3 flex gap-1.5">
                <TierBadge tier={r.tier} />
                {r.status === 'draft' && <DraftBadge />}
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-1.5 p-4">
              <h2 className="text-lg leading-snug font-bold group-hover:text-chili-700">
                {r.name}
              </h2>
              <p className="text-sm font-medium text-ink/80">{metaLine(r)}</p>
              {r.summary && (
                <p className="line-clamp-2 text-sm leading-6 text-muted">{r.summary}</p>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
