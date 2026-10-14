// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ContentIndex, RestaurantDetail, RestaurantSummary } from '../shared/content/model';
import { clearContentCache } from './lib/content';
import { clearGeocodeCache, GEOAPIFY_GEOCODE_ENDPOINT } from './lib/geocode';
import { clearPoiCache, OVERPASS_ENDPOINT, setOverpassRetryDelay } from './lib/poi';

// Leaflet does not run in jsdom: the picker map is a stub whose button is a
// tap on the map at a fixed point, and whose markers are plain buttons.
// Leaflet does not run in jsdom: the picker map is a stub. It reports the
// area around its view (as Leaflet does once ready and after moving), shows
// candidates as pin buttons, and offers buttons for a map tap, a pan to
// another area, and zooming far out.
vi.mock('./views/PickerMap', async () => {
  const { useEffect } = await import('react');
  type Point = { lat: number; lng: number };
  type Area = {
    center: Point;
    zoom: number;
    bounds: { south: number; west: number; north: number; east: number };
  };
  const areaAround = (center: Point, zoom: number): Area => ({
    center,
    zoom,
    bounds: {
      south: center.lat - 0.004,
      north: center.lat + 0.004,
      west: center.lng - 0.006,
      east: center.lng + 0.006,
    },
  });
  function PickerMapStub(props: {
    label: string;
    view: { center: Point; zoom: number };
    candidates?: { key: string; name: string }[];
    onMapClick?: (p: Point) => void;
    onMove?: (area: Area) => void;
    onSelect?: (c: unknown) => void;
  }) {
    const { view, onMove } = props;
    useEffect(() => {
      onMove?.(areaAround(view.center, view.zoom));
      // Like Leaflet: report when ready and when the view is set.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view]);
    return (
      <div
        aria-label={props.label}
        data-view={`${view.center.lat.toFixed(4)},${view.center.lng.toFixed(4)},${view.zoom}`}
      >
        {props.onMapClick && (
          <button type="button" onClick={() => props.onMapClick!({ lat: 29.7, lng: -95.4 })}>
            在地图上点一下
          </button>
        )}
        {onMove && (
          <>
            <button
              type="button"
              onClick={() => onMove(areaAround({ lat: 29.735, lng: -95.39 }, 15))}
            >
              拖动地图
            </button>
            <button type="button" onClick={() => onMove(areaAround(view.center, 11))}>
              缩小地图
            </button>
          </>
        )}
        {props.candidates?.map((c) => (
          <button key={c.key} type="button" onClick={() => props.onSelect?.(c)}>
            图钉：{c.name}
          </button>
        ))}
      </div>
    );
  }
  return { default: PickerMapStub };
});

/** The view the map was given: "lat,lng,zoom". */
const mapView = () => screen.getByLabelText('附近餐厅地图').getAttribute('data-view');

/** Hidden fields passed to the embedded form (its URL without the embed options). */
const formParams = () => {
  const params = new URL(screen.getByTitle('Rice Eats 投稿表单').getAttribute('src')!).searchParams;
  for (const option of ['alignLeft', 'hideTitle', 'transparentBackground']) params.delete(option);
  return Object.fromEntries(params);
};
const NEXT = '下一步：填写点评 →';

const BASE = import.meta.env.BASE_URL;

const summary = (id: string, extra: Partial<RestaurantSummary> = {}): RestaurantSummary => ({
  id,
  status: 'published',
  name: id,
  altNames: [],
  cuisines: [],
  tags: [],
  links: {},
  ...extra,
});

const img = (name: string, alt: string) => ({
  src: `/${name}.webp`,
  srcset: `/${name}.webp 480w`,
  width: 480,
  height: 320,
  alt,
});

const restaurants = [
  summary('bayou-bbq', {
    name: 'Bayou BBQ',
    cuisines: ['bbq'],
    tags: ['group'],
    rating: 5,
    pricePerPerson: 28,
    location: { lat: 29.74, lng: -95.39 },
  }),
  summary('pho-garden', {
    name: '河粉花园',
    altNames: ['Pho Garden', 'PG'],
    cuisines: ['vietnamese'],
    tags: ['budget'],
    rating: 3,
    pricePerPerson: 14,
  }),
  summary('food-truck', { name: 'Food Truck', cuisines: ['fast-food'] }),
];

// Photos: 0 cover, 1 dish photo, 2 placed in the review, 3 only in the gallery,
// 4 used by a dish and the review (the review wins).
const detail: RestaurantDetail = {
  ...restaurants[0]!,
  address: '1 Example St',
  cover: img('cover', 'Bayou BBQ'),
  images: [
    img('cover', 'Bayou BBQ'),
    img('brisket', 'Bayou BBQ (2)'),
    img('a', '图片说明'),
    img('extra', 'Bayou BBQ (4)'),
    img('ribs', '排骨'),
  ],
  dishes: [
    { name: '牛胸', verdict: 1, comment: '好吃', imageIndex: 1 },
    { name: '冰茶' },
    { name: '豆子', verdict: -1 },
    { name: '排骨', verdict: 1, imageIndex: 4 },
  ],
  reviewHtml:
    '<h2>标题</h2><figure><img src="/a.webp" alt="图片说明"><figcaption>图注</figcaption></figure><p>正文</p><p><img src="/ribs.webp" alt="排骨"></p>',
  reviewImageIndexes: [2, 4],
  contributors: [{ id: 'u-001', name: '作者甲' }],
};

let index: ContentIndex;
let failIndex = false;

beforeEach(() => {
  index = { source: 'content', includesDrafts: false, restaurants };
  failIndex = false;
  clearContentCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('generated/index.json')) {
        return failIndex ? new Response('', { status: 500 }) : Response.json(index);
      }
      if (url.endsWith(`generated/restaurants/${detail.id}.json`)) return Response.json(detail);
      return new Response('', { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function visit(path: string) {
  window.history.replaceState(null, '', `${BASE}${path}`);
  return render(<App />);
}

const names = (container: HTMLElement) =>
  within(container)
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent);

describe('browsing', () => {
  it('shows the list view with restaurant information', async () => {
    visit('');
    const list = await screen.findByRole('list', { name: '餐厅列表' });
    expect(names(list)).toEqual(['Bayou BBQ', '河粉花园', 'Food Truck']);
    // The English name (and other names) appear under the Chinese one.
    expect(within(list).getByText('Pho Garden / PG')).toBeInTheDocument();
    expect(within(list).getByText('美式烧烤 · 人均 $28')).toBeInTheDocument();
    expect(within(list).getByText('适合聚餐')).toBeInTheDocument();
    expect(screen.getByText('共 3 家')).toBeInTheDocument();
  });

  it('shares search and filters across views and keeps them in the URL', async () => {
    const user = userEvent.setup();
    visit('');
    await screen.findByRole('list', { name: '餐厅列表' });
    await user.selectOptions(screen.getByLabelText('按场景筛选'), 'group');
    expect(window.location.search).toBe('?tag=group');
    expect(names(screen.getByRole('list', { name: '餐厅列表' }))).toEqual(['Bayou BBQ']);

    await user.click(screen.getByRole('button', { name: '网格' }));
    expect(window.location.search).toBe('?view=grid&tag=group');
    expect(names(screen.getByRole('list', { name: '餐厅网格' }))).toEqual(['Bayou BBQ']);
    expect(screen.getByText('找到 1 家 / 共 3 家')).toBeInTheDocument();

    act(() => window.history.back());
    expect(await screen.findByRole('list', { name: '餐厅列表' })).toBeInTheDocument();
  });

  it('restores state from a shared URL and handles no results', async () => {
    const user = userEvent.setup();
    visit('?view=grid&q=zzz');
    expect(await screen.findByText('没有符合条件的餐厅')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('zzz');
    // Both the toolbar and the empty state offer "clear filters".
    expect(screen.getAllByRole('button', { name: '清除筛选' })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: '清除筛选' })[1]!);
    expect(names(await screen.findByRole('list', { name: '餐厅网格' }))).toHaveLength(3);
  });

  it('searches Chinese, English, and other names', async () => {
    const user = userEvent.setup();
    visit('');
    const box = await screen.findByRole('searchbox');
    await user.type(box, 'pho');
    expect(names(screen.getByRole('list', { name: '餐厅列表' }))).toEqual(['河粉花园']);
    expect(window.location.search).toBe('?q=pho');
    await user.clear(box);
    await user.type(box, '河粉');
    expect(names(screen.getByRole('list', { name: '餐厅列表' }))).toEqual(['河粉花园']);
  });

  it('shows a friendly empty state when nothing is published', async () => {
    index = { ...index, restaurants: [] };
    visit('');
    expect(await screen.findByText('餐厅点评正在准备中')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const user = userEvent.setup();
    failIndex = true;
    visit('');
    expect(await screen.findByText('内容加载失败')).toBeInTheDocument();
    failIndex = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('list', { name: '餐厅列表' })).toBeInTheDocument();
  });

  it('labels fixture data as fictional', async () => {
    index = { ...index, source: 'fixtures' };
    visit('');
    expect(await screen.findByText(/虚构的示例数据/)).toBeInTheDocument();
  });
});

describe('restaurant details', () => {
  it('opens from the list and renders text, images, and dishes', async () => {
    const user = userEvent.setup();
    visit('');
    await user.click(await screen.findByRole('link', { name: /Bayou BBQ/ }));
    expect(window.location.pathname).toBe(`${BASE}r/bayou-bbq/`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Bayou BBQ' })).toBeInTheDocument();
    // Cover = first image, alt text = restaurant name.
    expect(screen.getByRole('img', { name: 'Bayou BBQ' })).toHaveAttribute(
      'srcset',
      '/cover.webp 480w',
    );
    expect(screen.getByRole('img', { name: '图片说明' })).toBeInTheDocument();
    expect(screen.getByText('图注')).toBeInTheDocument();
    // Dishes: only explicit verdicts get labels; no verdict is not a recommendation.
    expect(screen.getAllByText(/推荐$/)).toHaveLength(2);
    expect(screen.getAllByText(/避雷/)).toHaveLength(2); // section heading + badge
    expect(screen.getByRole('heading', { name: '冰茶' }).closest('li')).not.toHaveTextContent(
      '推荐',
    );
    // Each photo appears once (see src/lib/imagePlacement.ts).
    const gallery = screen.getByRole('region', { name: '照片' });
    expect(
      within(gallery)
        .getAllByRole('img')
        .map((i) => i.getAttribute('src')),
    ).toEqual(['/extra.webp']);
    for (const name of ['cover', 'brisket', 'a', 'extra', 'ribs']) {
      const count = screen
        .getAllByRole('img')
        .filter((i) => i.getAttribute('src') === `/${name}.webp`).length;
      expect(count, name).toBe(1);
    }
    // The dish whose photo the review shows keeps its card.
    expect(screen.getByRole('heading', { name: '排骨' }).closest('li')).toHaveTextContent('推荐');
    // Map apps.
    expect(screen.getByRole('link', { name: /Google 地图导航/ }).getAttribute('href')).toContain(
      'https://www.google.com/maps/search/?api=1&query=29.74%2C-95.39',
    );
    expect(screen.getByRole('link', { name: /Apple 地图导航/ }).getAttribute('href')).toBe(
      'https://maps.apple.com/?q=Bayou+BBQ&ll=29.74%2C-95.39',
    );
    expect(screen.getByText(/作者甲/)).toBeInTheDocument();
    expect(document.title).toBe('Bayou BBQ · Rice Eats');

    await user.click(screen.getByRole('button', { name: '← 返回' }));
    expect(await screen.findByRole('list', { name: '餐厅列表' })).toBeInTheDocument();
  });

  it('works as a direct link and offers a way back', async () => {
    visit('r/bayou-bbq');
    expect(await screen.findByRole('heading', { level: 1, name: 'Bayou BBQ' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← 全部餐厅' })).toHaveAttribute('href', BASE);
  });

  it('shows not-found pages for unknown restaurants and paths', async () => {
    const { unmount } = visit('r/missing');
    expect(await screen.findByText('找不到这家餐厅')).toBeInTheDocument();
    unmount();
    visit('some/other/path');
    expect(await screen.findByText('页面不存在')).toBeInTheDocument();
  });
});

describe('submissions', () => {
  const FORM = 'https://tally.so/r/wMq8xY';
  afterEach(() => vi.unstubAllEnvs());

  it('hides every submission link until the form is configured', async () => {
    vi.stubEnv('VITE_TALLY_FORM', '');
    const { unmount } = visit('r/bayou-bbq');
    await screen.findByRole('heading', { level: 1, name: 'Bayou BBQ' });
    expect(screen.queryByRole('link', { name: '投稿' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '补充点评或照片' })).not.toBeInTheDocument();
    unmount();
    visit('submit/');
    expect(screen.getByText('投稿功能即将开放')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('treats an invalid setting as not configured', () => {
    vi.stubEnv('VITE_TALLY_FORM', 'https://example.com/form');
    visit('submit/');
    expect(screen.getByText('投稿功能即将开放')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '投稿' })).not.toBeInTheDocument();
  });

  it('offers a general entry in the header that works without restaurants', async () => {
    vi.stubEnv('VITE_TALLY_FORM', FORM);
    index = { ...index, restaurants: [] };
    const user = userEvent.setup();
    visit('');
    await screen.findByText('餐厅点评正在准备中');
    expect(screen.getByRole('link', { name: '推荐一家餐厅或分享照片' })).toHaveAttribute(
      'href',
      `${BASE}submit/`,
    );
    await user.click(screen.getByRole('link', { name: '投稿' }));
    expect(window.location.pathname).toBe(`${BASE}submit/`);
    expect(
      screen.getByRole('heading', { level: 1, name: '投稿：分享你的用餐体验' }),
    ).toBeInTheDocument();
    // No introductory paragraphs: the form itself explains review and privacy.
    expect(screen.queryByText(/不会立即出现在网站上/)).not.toBeInTheDocument();
    expect(screen.getByText('第一步 · 选择餐厅')).toBeInTheDocument();
    // The form loads only after a restaurant is confirmed.
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.title).toBe('投稿 · Rice Eats');
  });

  it('keeps manual entry working when restaurant search fails', async () => {
    vi.stubEnv('VITE_TALLY_FORM', FORM);
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', '');
    clearPoiCache();
    setOverpassRetryDelay(0);
    const user = userEvent.setup();
    visit('submit/');
    // No key: the map asks OpenStreetMap, which this test's network refuses.
    expect(await screen.findByText(/餐厅搜索出错了/)).toBeInTheDocument();
    expect(screen.getByText(/© OpenStreetMap contributors/)).toBeInTheDocument();
    expect(screen.queryByText(/Powered by Geoapify/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '手动添加餐厅' }));
    const next = screen.getByRole('button', { name: '下一步' });
    expect(next).toBeDisabled();
    await user.type(screen.getByLabelText('餐厅名称'), ' 小面馆 ');
    expect(next).toBeDisabled(); // needs a marker or "not sure"
    await user.click(await screen.findByRole('button', { name: '在地图上点一下' }));
    expect(screen.getByText('已标出位置，可以再点一下修改。')).toBeInTheDocument();
    await user.click(screen.getByLabelText(/我不确定具体位置/));
    await user.type(screen.getByLabelText('餐厅地址（选填）'), '5 Oak St');
    await user.click(next);
    // Back on the map page, with the manual entry selected in place.
    const selected = screen.getByRole('region', { name: '已选餐厅' });
    expect(within(selected).getByText('小面馆')).toBeInTheDocument();
    expect(within(selected).getByText('5 Oak St')).toBeInTheDocument();
    expect(within(selected).getByText(/没有位置信息，审核时会再核实/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NEXT }));
    expect(screen.getByText('第二步 · 填写点评')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: '为「小面馆」投稿' })).toHaveFocus();
    expect(formParams()).toEqual({
      restaurant_name: '小面馆',
      restaurant_address: '5 Oak St',
      selection_method: 'manual',
      source: 'site',
    });
    // Back to step 1: the entry stays selected and the map stays where it was.
    await user.click(screen.getByRole('button', { name: '更换餐厅' }));
    expect(
      within(screen.getByRole('region', { name: '已选餐厅' })).getByText('小面馆'),
    ).toBeInTheDocument();
    expect(mapView()).toBe('29.7174,-95.4018,15');
    await user.click(screen.getByRole('button', { name: NEXT }));
    expect(formParams()).toMatchObject({ restaurant_name: '小面馆', selection_method: 'manual' });
  });

  it('passes a manual marker as the restaurant location', async () => {
    vi.stubEnv('VITE_TALLY_FORM', FORM);
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', '');
    const user = userEvent.setup();
    visit('submit/');
    await user.click(await screen.findByRole('button', { name: '手动添加餐厅' }));
    await user.type(screen.getByLabelText('餐厅名称'), 'Corner Cafe');
    await user.click(await screen.findByRole('button', { name: '在地图上点一下' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByRole('button', { name: '图钉：Corner Cafe' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: NEXT }));
    const params = formParams();
    expect(params).toMatchObject({
      restaurant_name: 'Corner Cafe',
      restaurant_lat: '29.700000',
      restaurant_lng: '-95.400000',
      selection_method: 'manual',
    });
    expect(params.poi_id).toBeUndefined();
  });

  describe('with POI search', () => {
    const DEVICE = { latitude: 29.7111, longitude: -95.3999 };
    /** Fake places: two near Rice, one in the area the stub pans to, one near the device. */
    const PLACES = [
      {
        place_id: 'p-noodle',
        name: 'Noodle Corner',
        address_line2: '7 Pine St',
        lat: 29.7183,
        lon: -95.4012,
      },
      {
        place_id: 'p-taco',
        name: 'Taco Stop',
        address_line2: '9 Oak St',
        lat: 29.7352,
        lon: -95.3897,
      },
      {
        place_id: 'p-home',
        name: 'Home Cafe',
        address_line2: '1 Elm St',
        lat: 29.7113,
        lon: -95.4,
      },
      // In view at Rice, in the tile east of -95.40.
      {
        place_id: 'p-east',
        name: 'East Deli',
        address_line2: '3 Bay St',
        lat: 29.716,
        lon: -95.398,
      },
    ];
    let geolocation: { getCurrentPosition: ReturnType<typeof vi.fn> };
    let places: URL[];
    let placesStatus = 200;
    let overpass: string[];
    let overpassStatus = 200;
    /** Holds name searches around Rice until resolved (for out-of-order responses). */
    let slowRiceNames: Promise<void> | undefined;
    /** Per-tile Geoapify status for partial failures. */
    let tileStatus: ((filter: string) => number) | undefined;
    let geocodes: URL[];
    let geocodeStatus = 200;
    /** Requests to any other host (e.g. a public geocoder) — there must be none. */
    let unexpected: string[];
    /** Holds a geocoding answer (by query) until resolved, for out-of-order answers. */
    let geocodeHold: Map<string, Promise<void>>;
    const holdGeocode = (query: string) => {
      let release!: () => void;
      geocodeHold.set(query, new Promise<void>((resolve) => (release = resolve)));
      return release;
    };
    /** Fake geocoder: one match, two matches, or none, by query. */
    const GEOCODED: Record<string, object[]> = {
      norfolk: [
        {
          place_id: 'g-norfolk',
          address_line1: '2111 Norfolk St',
          address_line2: 'Houston, TX 77098, United States',
          housenumber: '2111',
          result_type: 'building',
          lat: 29.7333,
          lon: -95.4123,
        },
      ],
      westheimer: [
        {
          place_id: 'g-westheimer',
          address_line1: 'Westheimer Rd',
          address_line2: 'Houston, TX, United States',
          result_type: 'street',
          lat: 29.7375,
          lon: -95.4422,
        },
      ],
      'main st': [
        {
          place_id: 'g-main-1',
          address_line1: 'Main St',
          address_line2: 'Houston, TX, United States',
          result_type: 'street',
          lat: 29.75,
          lon: -95.37,
        },
        {
          place_id: 'g-main-2',
          address_line1: 'Main St',
          address_line2: 'Sugar Land, TX, United States',
          result_type: 'street',
          lat: 29.62,
          lon: -95.63,
        },
      ],
    };

    beforeEach(() => {
      vi.stubEnv('VITE_TALLY_FORM', FORM);
      vi.stubEnv('VITE_GEOAPIFY_API_KEY', 'test-key');
      clearPoiCache();
      setOverpassRetryDelay(0);
      places = [];
      placesStatus = 200;
      overpass = [];
      overpassStatus = 200;
      slowRiceNames = undefined;
      tileStatus = undefined;
      clearGeocodeCache();
      geocodes = [];
      geocodeStatus = 200;
      unexpected = [];
      geocodeHold = new Map();
      const indexFetch = vi.mocked(fetch);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === OVERPASS_ENDPOINT) {
            const query = new URLSearchParams(String(init?.body)).get('data')!;
            overpass.push(query);
            if (overpassStatus !== 200) return new Response('', { status: overpassStatus });
            const box = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query);
            const [s, w, n, e] = box ? box.slice(1).map(Number) : [-90, -180, 90, 180];
            const elements = PLACES.filter(
              (p) => p.lat >= s! && p.lat < n! && p.lon >= w! && p.lon < e!,
            ).map((p, i) => ({
              type: 'node',
              id: 100 + i,
              lat: p.lat,
              lon: p.lon,
              tags: { name: p.name, 'addr:street': p.address_line2 },
            }));
            return Response.json({ elements });
          }
          if (url.startsWith(GEOAPIFY_GEOCODE_ENDPOINT)) {
            const u = new URL(url);
            geocodes.push(u);
            const status = geocodeStatus;
            await geocodeHold.get(u.searchParams.get('text')!.toLowerCase());
            if (status !== 200) return new Response('', { status });
            const results = GEOCODED[u.searchParams.get('text')!.toLowerCase()] ?? [];
            return Response.json({ results });
          }
          if (/^https?:\/\//.test(url) && !url.startsWith('https://api.geoapify.com/')) {
            unexpected.push(url);
          }
          if (!url.startsWith('https://api.geoapify.com/')) return indexFetch(url, init);
          const u = new URL(url);
          places.push(u);
          if (placesStatus !== 200) return new Response('', { status: placesStatus });
          const name = u.searchParams.get('name');
          const filter = u.searchParams.get('filter')!;
          let matches = PLACES;
          if (filter.startsWith('rect:')) {
            const [w, s, e, n] = filter.slice(5).split(',').map(Number) as [
              number,
              number,
              number,
              number,
            ];
            matches = PLACES.filter((p) => p.lon >= w && p.lon < e && p.lat >= s && p.lat < n);
          }
          if (name) {
            // Named results depend on the search center: near Rice or north-east.
            const north = !filter.includes('29.720000');
            if (!north && slowRiceNames) await slowRiceNames;
            matches = [
              north
                ? { ...PLACES[1]!, name: `${name} North` }
                : { ...PLACES[0]!, name: `${name} Noodles` },
            ];
          }
          if (tileStatus && filter.startsWith('rect:')) {
            const status = tileStatus(filter);
            if (status !== 200) return new Response('', { status });
          }
          return Response.json({ features: matches.map((properties) => ({ properties })) });
        }),
      );
      geolocation = {
        getCurrentPosition: vi.fn((ok: PositionCallback) =>
          ok({ coords: DEVICE } as GeolocationPosition),
        ),
      };
      vi.stubGlobal('navigator', { ...navigator, geolocation });
    });

    const rects = () => places.filter((u) => u.searchParams.get('filter')!.startsWith('rect:'));

    it('shows restaurants around Rice as pins on load and submits the chosen one', async () => {
      const user = userEvent.setup();
      visit('submit/');
      const pin = await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      expect(screen.getByText('地图上有 2 家餐厅，点图钉选择。')).toBeInTheDocument();
      // The location is never requested without a click.
      expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
      // The visible area is loaded as cached tiles covering Rice University.
      expect(rects().length).toBeGreaterThan(0);
      expect(rects().every((u) => u.searchParams.get('limit') === '500')).toBe(true);
      expect(screen.getByText(/Powered by Geoapify/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '搜索地图中心附近' })).not.toBeInTheDocument();
      await user.click(pin);
      // Selected in place: shown below the map, no separate confirmation step.
      const selected = screen.getByRole('region', { name: '已选餐厅' });
      expect(within(selected).getByText('Noodle Corner')).toBeInTheDocument();
      expect(within(selected).getByText('7 Pine St')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '确认餐厅' })).not.toBeInTheDocument();
      expect(document.querySelector('iframe')).toBeNull();
      await user.click(screen.getByRole('button', { name: NEXT }));
      expect(formParams()).toEqual({
        restaurant_name: 'Noodle Corner',
        restaurant_lat: '29.718300',
        restaurant_lng: '-95.401200',
        restaurant_address: '7 Pine St',
        poi_provider: 'geoapify',
        poi_id: 'p-noodle',
        selection_method: 'poi',
        source: 'site',
      });
    });

    it('updates the pins when the map moves, reusing loaded tiles', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      await user.click(screen.getByRole('button', { name: '拖动地图' }));
      expect(await screen.findByRole('button', { name: '图钉：Taco Stop' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '图钉：Noodle Corner' })).not.toBeInTheDocument();
      const loaded = rects().length;
      await user.click(screen.getByRole('button', { name: '拖动地图' }));
      await screen.findByText('地图上有 1 家餐厅，点图钉选择。');
      expect(rects().length).toBe(loaded); // cached
      await user.click(screen.getByRole('button', { name: '缩小地图' }));
      expect(await screen.findByText('放大地图就能看到附近的餐厅。')).toBeInTheDocument();
      expect(rects().length).toBe(loaded);
    });

    it('moves the map to the current location and never submits the device position', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      await user.click(screen.getByRole('button', { name: '使用当前位置' }));
      await user.click(await screen.findByRole('button', { name: '图钉：Home Cafe' }));
      await user.click(screen.getByRole('button', { name: NEXT }));
      const params = formParams();
      expect(params.restaurant_lat).toBe('29.711300');
      expect(JSON.stringify(params)).not.toContain('29.7111');
    });

    it('explains a denied location permission and keeps the map usable', async () => {
      geolocation.getCurrentPosition.mockImplementation(
        (_ok: PositionCallback, fail: PositionErrorCallback) =>
          fail({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError),
      );
      const user = userEvent.setup();
      visit('submit/');
      await user.click(await screen.findByRole('button', { name: '使用当前位置' }));
      expect(screen.getByText(/没有获得定位权限/)).toBeInTheDocument();
      expect(
        await screen.findByRole('button', { name: '图钉：Noodle Corner' }),
      ).toBeInTheDocument();
    });

    it('searches by name', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      await user.type(screen.getByRole('searchbox', { name: '在当前区域搜索餐厅' }), 'Pho');
      const list = await screen.findByRole('list', { name: '搜索结果' });
      // Debounced: one request for the whole query, around the map center.
      const byName = places.filter((u) => u.searchParams.has('name'));
      expect(byName).toHaveLength(1);
      // Around the map center, snapped to a ~2 km grid.
      expect(byName[0]!.searchParams.get('filter')).toBe('circle:-95.400000,29.720000,5000');
      await user.click(within(list).getByRole('button', { name: /Pho Noodles/ }));
      // Same feedback as a pin: selected in place, with its pin highlighted.
      expect(
        within(screen.getByRole('region', { name: '已选餐厅' })).getByText('Pho Noodles'),
      ).toBeInTheDocument();
      expect(within(list).getByRole('button', { name: /Pho Noodles/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('searches the new area when the map moves during a name search', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      await user.type(screen.getByRole('searchbox', { name: '在当前区域搜索餐厅' }), 'Pho');
      await screen.findByRole('button', { name: '图钉：Pho Noodles' });
      await user.click(screen.getByRole('button', { name: '拖动地图' }));
      const list = await screen.findByRole('list', { name: '搜索结果' });
      await within(list).findByRole('button', { name: /Pho North/ });
      expect(within(list).queryByRole('button', { name: /Pho Noodles/ })).not.toBeInTheDocument();
      const byName = places.filter((u) => u.searchParams.has('name'));
      expect(byName.map((u) => u.searchParams.get('filter'))).toEqual([
        'circle:-95.400000,29.720000,5000',
        'circle:-95.380000,29.740000,5000',
      ]);
    });

    it('never shows a late answer for an area the map has left', async () => {
      let release!: () => void;
      slowRiceNames = new Promise((resolve) => (release = resolve));
      const user = userEvent.setup();
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      await user.type(screen.getByRole('searchbox', { name: '在当前区域搜索餐厅' }), 'Pho');
      await waitFor(() => expect(places.filter((u) => u.searchParams.has('name'))).toHaveLength(1));
      await user.click(screen.getByRole('button', { name: '拖动地图' }));
      await screen.findByRole('button', { name: '图钉：Pho North' });
      release();
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole('button', { name: '图钉：Pho Noodles' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '图钉：Pho North' })).toBeInTheDocument();
    });

    it('keeps the restaurants that loaded when part of the map fails, and retries', async () => {
      // Tiles west of -95.40 fail on Geoapify; the Overpass fallback is busy.
      tileStatus = (filter) => (filter.startsWith('rect:-95.41') ? 500 : 200);
      overpassStatus = 504;
      const user = userEvent.setup();
      visit('submit/');
      expect(await screen.findByText(/部分区域没能加载/)).toBeInTheDocument();
      // East Deli's tile loaded; Noodle Corner's did not.
      expect(screen.getByRole('button', { name: '图钉：East Deli' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '图钉：Noodle Corner' })).not.toBeInTheDocument();
      overpassStatus = 200;
      await user.click(screen.getByRole('button', { name: '重试' }));
      expect(
        await screen.findByRole('button', { name: '图钉：Noodle Corner' }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/部分区域没能加载/)).not.toBeInTheDocument();
    });

    it('recovers from a complete failure with 重试', async () => {
      placesStatus = 503;
      overpassStatus = 504;
      const user = userEvent.setup();
      visit('submit/');
      expect(await screen.findByText(/餐厅搜索出错了/)).toBeInTheDocument();
      placesStatus = 200;
      await user.click(screen.getByRole('button', { name: '重试' }));
      expect(
        await screen.findByRole('button', { name: '图钉：Noodle Corner' }),
      ).toBeInTheDocument();
    });

    it('falls back to OpenStreetMap when Geoapify is out of credits', async () => {
      placesStatus = 429;
      const user = userEvent.setup();
      visit('submit/');
      await user.click(await screen.findByRole('button', { name: '图钉：Noodle Corner' }));
      await user.click(screen.getByRole('button', { name: NEXT }));
      expect(formParams()).toMatchObject({
        restaurant_name: 'Noodle Corner',
        restaurant_address: '7 Pine St',
        poi_provider: 'osm',
        poi_id: 'node/100',
        selection_method: 'poi',
      });
      // After Geoapify refused, new areas go straight to OpenStreetMap.
      const asked = rects().length;
      await user.click(screen.getByRole('button', { name: '更换餐厅' }));
      await user.click(screen.getByRole('button', { name: '拖动地图' }));
      expect(await screen.findByRole('button', { name: '图钉：Taco Stop' })).toBeInTheDocument();
      expect(rects()).toHaveLength(asked);
      // One Overpass request per area, not one per tile.
      expect(overpass).toHaveLength(2);
    });

    it('shows search errors with the manual fallback', async () => {
      placesStatus = 429;
      overpassStatus = 429;
      visit('submit/');
      expect(await screen.findByText(/餐厅搜索暂时不可用/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '手动添加餐厅' })).toBeInTheDocument();
    });

    it('locates the preset areas without a request or a selection', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      const status = () => screen.getByText(/^当前查找区域：/);
      expect(status()).toHaveTextContent('当前查找区域：Rice University 周边');
      await user.click(screen.getByRole('button', { name: 'Chinatown 周边' }));
      // Bellaire Blvd in southwest Houston, not Downtown.
      expect(mapView()).toBe('29.7040,-95.5560,15');
      expect(status()).toHaveTextContent('当前查找区域：Chinatown 周边');
      expect(screen.queryByRole('region', { name: '已选餐厅' })).not.toBeInTheDocument();
      expect(geocodes).toHaveLength(0);
      // Panning away: the page no longer claims the old area.
      await user.click(screen.getByRole('button', { name: '拖动地图' }));
      expect(status()).toHaveTextContent('当前查找区域：地图当前位置附近');
      await user.click(screen.getByRole('button', { name: 'Rice University 周边' }));
      expect(mapView()).toBe('29.7174,-95.4018,15');
      expect(status()).toHaveTextContent('当前查找区域：Rice University 周边');
    });

    it('searches an address only when asked and lets the contributor pick among matches', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      const input = screen.getByRole('searchbox', { name: '输入地址或地点' });
      await user.type(input, 'Main St');
      // Typing alone sends nothing.
      expect(geocodes).toHaveLength(0);
      await user.click(screen.getByRole('button', { name: '搜索' }));
      const results = await screen.findByRole('list', { name: '地点搜索结果' });
      expect(geocodes).toHaveLength(1);
      expect(geocodes[0]!.searchParams.get('bias')).toBe('proximity:-95.4018,29.7174');
      expect(screen.getByText('找到多个地点，请选择：')).toBeInTheDocument();
      // Ambiguous: the map waits for a choice.
      expect(mapView()).toBe('29.7174,-95.4018,15');
      await user.click(within(results).getByRole('button', { name: /Sugar Land/ }));
      expect(mapView()).toBe('29.6200,-95.6300,16');
      expect(screen.getByText(/^当前查找区域：/)).toHaveTextContent('当前查找区域：Main St');
      expect(screen.queryByRole('region', { name: '已选餐厅' })).not.toBeInTheDocument();

      // A single match moves the map at once.
      await user.clear(input);
      await user.type(input, 'Norfolk{Enter}');
      await waitFor(() => expect(mapView()).toBe('29.7333,-95.4123,16'));
      expect(screen.getByText(/^当前查找区域：/)).toHaveTextContent('2111 Norfolk St');
      // Repeating a search from the same area is answered from the cache.
      await user.click(screen.getByRole('button', { name: '搜索' }));
      await waitFor(() => expect(geocodes).toHaveLength(3));
      await user.click(screen.getByRole('button', { name: '搜索' }));
      await user.click(screen.getByRole('button', { name: '搜索' }));
      expect(geocodes).toHaveLength(3);
    });

    it('explains failed or empty address searches and retries', async () => {
      const user = userEvent.setup();
      geocodeStatus = 429;
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      const input = screen.getByRole('searchbox', { name: '输入地址或地点' });
      await user.type(input, 'Norfolk{Enter}');
      // Geoapify refused: no other geocoder is asked.
      expect(await screen.findByText(/地点搜索暂时不可用/)).toBeInTheDocument();
      expect(geocodes).toHaveLength(1);
      expect(unexpected).toEqual([]);
      // The presets and the map still work, and the old message goes away.
      await user.click(screen.getByRole('button', { name: 'Chinatown 周边' }));
      expect(mapView()).toBe('29.7040,-95.5560,15');
      expect(screen.queryByText(/地点搜索暂时不可用/)).not.toBeInTheDocument();
      // Failures are not cached: searching again asks again.
      await user.type(input, '{Enter}');
      expect(await screen.findByText(/地点搜索暂时不可用/)).toBeInTheDocument();
      expect(geocodes).toHaveLength(2);
      geocodeStatus = 200;
      await user.click(screen.getByRole('button', { name: '重试' }));
      await waitFor(() => expect(mapView()).toBe('29.7333,-95.4123,16'));
      await user.clear(input);
      await user.type(input, 'Nowhere Place{Enter}');
      expect(await screen.findByText(/没有找到「Nowhere Place」/)).toBeInTheDocument();
      // The map stays where it was, and usable.
      expect(mapView()).toBe('29.7333,-95.4123,16');
      expect(screen.getByRole('button', { name: '拖动地图' })).toBeInTheDocument();
    });

    describe('the last location request wins', () => {
      const status = () => screen.getByText(/^当前查找区域：/);
      const CHINATOWN = '29.7040,-95.5560,15';
      /** Geolocation that answers only when the test says so. */
      const pendingLocation = () => {
        const pending: { ok: PositionCallback; fail: PositionErrorCallback }[] = [];
        geolocation.getCurrentPosition.mockImplementation(
          (ok: PositionCallback, fail: PositionErrorCallback) => pending.push({ ok, fail }),
        );
        return {
          succeed: () => act(() => pending.shift()!.ok({ coords: DEVICE } as GeolocationPosition)),
          deny: () =>
            act(() =>
              pending.shift()!.fail({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError),
            ),
        };
      };
      const ready = async () => {
        visit('submit/');
        await screen.findByRole('button', { name: '图钉：Noodle Corner' });
        return screen.getByRole('searchbox', { name: '输入地址或地点' });
      };

      it('keeps a preset chosen while an address search was pending', async () => {
        const user = userEvent.setup();
        const release = holdGeocode('norfolk');
        const input = await ready();
        await user.type(input, 'Norfolk{Enter}');
        expect(screen.getByText('正在搜索地点…')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Chinatown 周边' }));
        expect(mapView()).toBe(CHINATOWN);
        await act(async () => release());
        await new Promise((r) => setTimeout(r, 20));
        expect(mapView()).toBe(CHINATOWN);
        expect(status()).toHaveTextContent('Chinatown 周边');
        expect(screen.queryByText('正在搜索地点…')).not.toBeInTheDocument();
        expect(screen.queryByRole('list', { name: '地点搜索结果' })).not.toBeInTheDocument();
      });

      it('uses the later of two searches when the earlier answers last', async () => {
        const user = userEvent.setup();
        const release = holdGeocode('norfolk');
        const input = await ready();
        await user.type(input, 'Norfolk{Enter}');
        await user.clear(input);
        await user.type(input, 'Westheimer{Enter}');
        await waitFor(() => expect(mapView()).toBe('29.7375,-95.4422,16'));
        await act(async () => release());
        await new Promise((r) => setTimeout(r, 20));
        expect(mapView()).toBe('29.7375,-95.4422,16');
        expect(status()).toHaveTextContent('Westheimer Rd');
        expect(screen.queryByText('2111 Norfolk St')).not.toBeInTheDocument();
      });

      it('ignores a location that arrives after a preset was chosen', async () => {
        const user = userEvent.setup();
        const location = pendingLocation();
        await ready();
        await user.click(screen.getByRole('button', { name: '使用当前位置' }));
        expect(screen.getByRole('button', { name: '正在定位…' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Rice University 周边' }));
        // The preset applies at once, without waiting for the location.
        expect(screen.getByRole('button', { name: '使用当前位置' })).toBeEnabled();
        location.succeed();
        expect(mapView()).toBe('29.7174,-95.4018,15');
        expect(status()).toHaveTextContent('Rice University 周边');
        // A late failure shows no message either.
        await user.click(screen.getByRole('button', { name: '使用当前位置' }));
        await user.click(screen.getByRole('button', { name: 'Chinatown 周边' }));
        location.deny();
        expect(screen.queryByText(/没有获得定位权限/)).not.toBeInTheDocument();
        expect(mapView()).toBe(CHINATOWN);
      });

      it('shows no stale error after the contributor moved on', async () => {
        const user = userEvent.setup();
        geocodeStatus = 503;
        const release = holdGeocode('norfolk');
        const input = await ready();
        await user.type(input, 'Norfolk{Enter}');
        await user.click(screen.getByRole('button', { name: 'Chinatown 周边' }));
        await act(async () => release());
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByText(/地点搜索暂时不可用/)).not.toBeInTheDocument();
        expect(mapView()).toBe(CHINATOWN);
      });

      it('keeps the result the contributor chose over a later location answer', async () => {
        const user = userEvent.setup();
        const location = pendingLocation();
        const input = await ready();
        await user.click(screen.getByRole('button', { name: '使用当前位置' }));
        await user.type(input, 'Main St{Enter}');
        await user.click(
          within(await screen.findByRole('list', { name: '地点搜索结果' })).getByRole('button', {
            name: /Sugar Land/,
          }),
        );
        location.succeed();
        expect(mapView()).toBe('29.6200,-95.6300,16');
        expect(status()).toHaveTextContent('Main St');
      });

      it('never moves a manually placed marker, whatever answers late', async () => {
        const user = userEvent.setup();
        const location = pendingLocation();
        const release = holdGeocode('norfolk');
        visit('submit/');
        await user.click(await screen.findByRole('button', { name: '手动添加餐厅' }));
        await user.type(screen.getByLabelText('餐厅名称'), 'Marker Cafe');
        await user.click(screen.getByRole('button', { name: '在地图上点一下' }));
        expect(screen.getByText('已标出位置，可以再点一下修改。')).toBeInTheDocument();
        await user.type(
          screen.getByRole('searchbox', { name: '输入地址或地点' }),
          'Norfolk{Enter}',
        );
        await user.click(screen.getByRole('button', { name: '使用当前位置' }));
        await user.click(screen.getByRole('button', { name: 'Chinatown 周边' }));
        await act(async () => release());
        await new Promise((r) => setTimeout(r, 20));
        location.succeed();
        const manualMap = screen.getByLabelText('标出餐厅位置的地图');
        expect(manualMap.getAttribute('data-view')).toBe(CHINATOWN);
        // No offer to use the stale search result as the location.
        expect(
          screen.queryByRole('button', { name: '用这个地点作为餐厅位置' }),
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: '下一步' }));
        await user.click(screen.getByRole('button', { name: NEXT }));
        expect(formParams()).toMatchObject({
          restaurant_name: 'Marker Cafe',
          restaurant_lat: '29.700000',
          restaurant_lng: '-95.400000',
        });
      });

      it('ignores answers that arrive after the area controls are gone', async () => {
        const user = userEvent.setup();
        const location = pendingLocation();
        const release = holdGeocode('norfolk');
        const input = await ready();
        await user.type(input, 'Norfolk{Enter}');
        await user.click(screen.getByRole('button', { name: '使用当前位置' }));
        // Leaving the selection map unmounts its area controls.
        await user.click(screen.getByRole('button', { name: '手动添加餐厅' }));
        const manualMap = () =>
          screen.getByLabelText('标出餐厅位置的地图').getAttribute('data-view');
        const before = manualMap();
        await act(async () => release());
        await new Promise((r) => setTimeout(r, 20));
        location.succeed();
        expect(manualMap()).toBe(before);
        expect(screen.getByText(/^当前查找区域：/)).toHaveTextContent('Rice University 周边');
        // Back on the selection map, nothing moved it while it was gone.
        await user.click(screen.getByRole('button', { name: '返回搜索' }));
        expect(mapView()).toBe('29.7174,-95.4018,15');
        expect(screen.getByText(/^当前查找区域：/)).toHaveTextContent('Rice University 周边');
      });
    });

    it('searches restaurant names around the current area', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      expect(screen.getByText(/搜索地图中心约 3.1 mi 范围内的餐厅/)).toBeInTheDocument();
      const named = () => places.filter((u) => u.searchParams.get('name'));
      await user.type(screen.getByRole('searchbox', { name: '在当前区域搜索餐厅' }), 'Pho');
      await waitFor(() => expect(named()).toHaveLength(1));
      // 5,000 m is the 3.1 mi shown.
      expect(named()[0]!.searchParams.get('filter')).toMatch(/,5000$/);
      await user.click(screen.getByRole('button', { name: 'Chinatown 周边' }));
      await waitFor(() => expect(named()).toHaveLength(2));
      expect(named()[1]!.searchParams.get('filter')).toBe('circle:-95.560000,29.700000,5000');
    });

    it('adds a restaurant by hand with the area controls, never using the area as its location', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await user.click(await screen.findByRole('button', { name: '手动添加餐厅' }));
      await user.type(screen.getByLabelText('餐厅名称'), 'Norfolk Noodles');
      const next = screen.getByRole('button', { name: '下一步' });
      await user.click(screen.getByRole('button', { name: 'Chinatown 周边' }));
      expect(screen.getByText(/^当前查找区域：/)).toHaveTextContent('Chinatown 周边');
      // Locating an area does not place the restaurant.
      expect(next).toBeDisabled();
      expect(screen.getByText('在地图上点一下餐厅所在的位置：')).toBeInTheDocument();
      // No other restaurants on this map.
      expect(screen.queryByRole('button', { name: /^图钉：/ })).not.toBeInTheDocument();
      await user.type(screen.getByRole('searchbox', { name: '输入地址或地点' }), 'Norfolk{Enter}');
      await user.click(await screen.findByRole('button', { name: '用这个地点作为餐厅位置' }));
      expect(screen.getByText('已标出位置，可以再点一下修改。')).toBeInTheDocument();
      expect(screen.getByLabelText('餐厅地址（选填）')).toHaveValue(
        'Houston, TX 77098, United States',
      );
      await user.click(next);
      await user.click(screen.getByRole('button', { name: NEXT }));
      expect(formParams()).toMatchObject({
        restaurant_name: 'Norfolk Noodles',
        restaurant_lat: '29.733300',
        restaurant_lng: '-95.412300',
        selection_method: 'manual',
      });
    });

    it('focuses a chosen restaurant and restores the last map view after step 2', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await user.click(await screen.findByRole('button', { name: '图钉：Noodle Corner' }));
      // Choosing focuses the map on the restaurant.
      expect(mapView()).toBe('29.7183,-95.4012,16');
      // The contributor keeps browsing, then continues and comes back.
      await user.click(screen.getByRole('button', { name: '拖动地图' }));
      await user.click(screen.getByRole('button', { name: NEXT }));
      await user.click(screen.getByRole('button', { name: '更换餐厅' }));
      expect(mapView()).toBe('29.7350,-95.3900,15');
      expect(
        within(screen.getByRole('region', { name: '已选餐厅' })).getByText('Noodle Corner'),
      ).toBeInTheDocument();
      // Choosing another restaurant focuses on it.
      await user.click(await screen.findByRole('button', { name: '图钉：Taco Stop' }));
      expect(mapView()).toBe('29.7352,-95.3897,16');
      await user.click(screen.getByRole('button', { name: NEXT }));
      expect(formParams()).toMatchObject({ restaurant_name: 'Taco Stop', poi_id: 'p-taco' });
    });

    it('lists the restaurants in view for choosing without the pins', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await screen.findByRole('button', { name: '图钉：Noodle Corner' });
      await user.click(screen.getByText('按列表查看这 2 家餐厅'));
      const list = screen.getByRole('list', { name: '地图上的餐厅' });
      // Nearest the map center first.
      expect(
        within(list)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Noodle Corner7 Pine St', 'East Deli3 Bay St']);
      await user.click(within(list).getByRole('button', { name: /East Deli/ }));
      expect(
        within(screen.getByRole('region', { name: '已选餐厅' })).getByText('East Deli'),
      ).toBeInTheDocument();
      expect(within(list).getByRole('button', { name: /East Deli/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('lets the contributor change the selection and come back from step 2', async () => {
      const user = userEvent.setup();
      visit('submit/');
      await user.click(await screen.findByRole('button', { name: '图钉：Noodle Corner' }));
      await user.click(screen.getByRole('button', { name: '图钉：East Deli' }));
      const selected = () => screen.getByRole('region', { name: '已选餐厅' });
      expect(within(selected()).getByText('East Deli')).toBeInTheDocument();
      expect(within(selected()).queryByText('Noodle Corner')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: NEXT }));
      expect(
        screen.getByRole('heading', { level: 1, name: '为「East Deli」投稿' }),
      ).toBeInTheDocument();
      // The name appears once: no "餐厅：…" line next to 更换餐厅.
      expect(screen.getAllByText(/East Deli/)).toHaveLength(1);
      expect(screen.queryByText(/在新窗口打开投稿表单/)).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '更换餐厅' }));
      // Back on step 1 with the selection kept.
      expect(screen.getByText('第一步 · 选择餐厅')).toBeInTheDocument();
      expect(within(selected()).getByText('East Deli')).toBeInTheDocument();
      expect(document.querySelector('iframe')).toBeNull();
    });
  });

  it('passes the restaurant from a restaurant page and allows changing it', async () => {
    vi.stubEnv('VITE_TALLY_FORM', FORM);
    const user = userEvent.setup();
    visit('r/bayou-bbq');
    await user.click(await screen.findByRole('link', { name: '补充点评或照片' }));
    expect(window.location.pathname + window.location.search).toBe(
      `${BASE}submit/?restaurant=bayou-bbq`,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: '为「Bayou BBQ」投稿' }),
    ).toBeInTheDocument();
    expect(formParams()).toEqual({
      restaurant_id: 'bayou-bbq',
      restaurant_name: 'Bayou BBQ',
      restaurant_lat: '29.740000',
      restaurant_lng: '-95.390000',
      selection_method: 'existing',
      source: 'restaurant-page',
    });
    expect(screen.getByTitle('Rice Eats 投稿表单').getAttribute('src')).toContain(
      'restaurant_id=bayou-bbq&restaurant_name=Bayou+BBQ',
    );
    expect(screen.getByText('第二步 · 填写点评')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← 返回餐厅页面' })).toHaveAttribute(
      'href',
      `${BASE}r/bayou-bbq/`,
    );
    await user.click(screen.getByRole('button', { name: '更换餐厅' }));
    expect(screen.getByText('第一步 · 选择餐厅')).toBeInTheDocument();
    // The map opens on that restaurant.
    expect(mapView()).toBe('29.7400,-95.3900,16');
    // The restaurant stays selected (its pin and the panel) until another is chosen.
    expect(
      within(screen.getByRole('region', { name: '已选餐厅' })).getByText('Bayou BBQ'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '图钉：Bayou BBQ' })).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
    await user.click(screen.getByRole('button', { name: NEXT }));
    expect(formParams()).toMatchObject({ restaurant_id: 'bayou-bbq', source: 'restaurant-page' });
  });

  describe('embedded form loading', () => {
    const FALLBACK = /在新窗口打开投稿表单/;
    /** Tally's message from the embedded form (or, with other arguments, an impostor). */
    const tallyMessage = (
      frame: HTMLIFrameElement,
      { formId = 'wMq8xY', origin = 'https://tally.so', source = frame.contentWindow } = {},
    ) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ event: 'Tally.FormLoaded', payload: { formId } }),
            origin,
            source,
          }),
        );
      });
    const frame = () => screen.getByTitle<HTMLIFrameElement>('Rice Eats 投稿表单');

    beforeEach(() => {
      vi.stubEnv('VITE_TALLY_FORM', FORM);
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => vi.useRealTimers());

    it('shows the form without recovery options once Tally reports it loaded', async () => {
      visit('submit/?restaurant=bayou-bbq');
      await screen.findByTitle('Rice Eats 投稿表单');
      expect(screen.getByText('正在加载投稿表单…')).toBeInTheDocument();
      tallyMessage(frame());
      expect(screen.queryByText('正在加载投稿表单…')).not.toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(30000));
      expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '重新加载表单' })).not.toBeInTheDocument();
    });

    it('offers recovery when the form loads slowly or not at all', async () => {
      visit('submit/?restaurant=bayou-bbq');
      await screen.findByTitle('Rice Eats 投稿表单');
      act(() => void vi.advanceTimersByTime(9000));
      expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(2000));
      expect(screen.getByText(/表单好像没有正常加载/)).toBeInTheDocument();
      const link = screen.getByRole('link', { name: FALLBACK });
      expect(link).toHaveAttribute('target', '_blank');
      // The new window gets the same restaurant, without the embed options.
      const direct = new URL(link.getAttribute('href')!);
      expect(direct.origin + direct.pathname).toBe('https://tally.so/r/wMq8xY');
      expect(Object.fromEntries(direct.searchParams)).toEqual(formParams());
      // A late load still clears the notice.
      tallyMessage(frame());
      expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
    });

    it('does not count a frame that loaded an error page as the form', async () => {
      visit('submit/?restaurant=bayou-bbq');
      await screen.findByTitle('Rice Eats 投稿表单');
      // The iframe's load event fires for any page, including Tally's error page.
      act(() => void frame().dispatchEvent(new Event('load')));
      // Messages from elsewhere, or about another form, do not count either.
      tallyMessage(frame(), { origin: 'https://evil.example' });
      tallyMessage(frame(), { formId: 'other' });
      tallyMessage(frame(), { source: window });
      act(() => void vi.advanceTimersByTime(11000));
      expect(screen.getByRole('link', { name: FALLBACK })).toBeInTheDocument();
    });

    it('reloads the form on request and starts the check again', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      visit('submit/?restaurant=bayou-bbq');
      await screen.findByTitle('Rice Eats 投稿表单');
      act(() => void vi.advanceTimersByTime(11000));
      const before = frame();
      await user.click(screen.getByRole('button', { name: '重新加载表单' }));
      // A new frame with the same restaurant, and no stale notice.
      expect(frame()).not.toBe(before);
      expect(formParams()).toMatchObject({ restaurant_id: 'bayou-bbq' });
      expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
      expect(screen.getByText('正在加载投稿表单…')).toBeInTheDocument();
      tallyMessage(frame());
      act(() => void vi.advanceTimersByTime(11000));
      expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
    });

    it('starts a fresh form after changing the restaurant', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      visit('submit/?restaurant=bayou-bbq');
      await screen.findByTitle('Rice Eats 投稿表单');
      act(() => void vi.advanceTimersByTime(11000));
      expect(screen.getByRole('link', { name: FALLBACK })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '更换餐厅' }));
      await user.click(screen.getByRole('button', { name: '手动添加餐厅' }));
      await user.type(screen.getByLabelText('餐厅名称'), 'Other Place');
      await user.click(screen.getByLabelText(/我不确定具体位置/));
      await user.click(screen.getByRole('button', { name: '下一步' }));
      await user.click(screen.getByRole('button', { name: NEXT }));
      // The old timeout does not carry over to the new form.
      expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
      expect(screen.getByText('正在加载投稿表单…')).toBeInTheDocument();
      expect(formParams()).toMatchObject({ restaurant_name: 'Other Place' });
      act(() => void vi.advanceTimersByTime(11000));
      expect(
        new URL(
          screen.getByRole('link', { name: FALLBACK }).getAttribute('href')!,
        ).searchParams.get('restaurant_name'),
      ).toBe('Other Place');
    });
  });

  it('ignores unknown restaurant ids and lets the contributor choose', async () => {
    vi.stubEnv('VITE_TALLY_FORM', FORM);
    visit('submit/?restaurant=r-fake99');
    expect(
      await screen.findByRole('heading', { level: 1, name: '投稿：分享你的用餐体验' }),
    ).toBeInTheDocument();
    expect(screen.getByText('第一步 · 选择餐厅')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('r-fake99');
  });

  it('keeps submissions possible when restaurant data cannot load', async () => {
    vi.stubEnv('VITE_TALLY_FORM', FORM);
    failIndex = true;
    visit('submit/?restaurant=bayou-bbq');
    expect(await screen.findByText('第一步 · 选择餐厅')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '手动添加餐厅' })).toBeInTheDocument();
  });
});
