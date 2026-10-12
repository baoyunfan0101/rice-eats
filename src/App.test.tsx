// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ContentIndex, RestaurantDetail, RestaurantSummary } from '../shared/content/model';
import { clearContentCache } from './lib/content';

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
    name: 'Pho Garden',
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
    expect(names(list)).toEqual(['Bayou BBQ', 'Pho Garden', 'Food Truck']);
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

  it('searches by name', async () => {
    const user = userEvent.setup();
    visit('');
    await user.type(await screen.findByRole('searchbox'), 'pho');
    expect(names(screen.getByRole('list', { name: '餐厅列表' }))).toEqual(['Pho Garden']);
    expect(window.location.search).toBe('?q=pho');
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
      'https://www.google.com/maps/search/?api=1&query=Bayou%20BBQ%2C%201%20Example%20St',
    );
    expect(screen.getByRole('link', { name: /Apple 地图导航/ }).getAttribute('href')).toBe(
      'https://maps.apple.com/?q=Bayou+BBQ&ll=29.74%2C-95.39',
    );
    expect(screen.getByText(/作者甲/)).toBeInTheDocument();
    expect(document.title).toBe('Bayou BBQ · Rice吃啥');

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
    expect(screen.getByText(/不会立即出现在网站上，也不保证一定发布/)).toBeInTheDocument();
    expect(screen.getByTitle('Rice吃啥 投稿表单')).toHaveAttribute(
      'src',
      'https://tally.so/embed/wMq8xY?alignLeft=1&hideTitle=1&transparentBackground=1&source=site',
    );
    expect(screen.getByRole('link', { name: /在新窗口打开投稿表单/ })).toHaveAttribute(
      'href',
      'https://tally.so/r/wMq8xY?source=site',
    );
    expect(document.title).toBe('投稿 · Rice吃啥');
  });

  it('passes the restaurant id and name from a restaurant page', async () => {
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
    const direct = new URL(
      screen.getByRole('link', { name: /在新窗口打开投稿表单/ }).getAttribute('href')!,
    );
    expect(Object.fromEntries(direct.searchParams)).toEqual({
      restaurant_id: 'bayou-bbq',
      restaurant_name: 'Bayou BBQ',
      source: 'restaurant-page',
    });
    expect(screen.getByTitle('Rice吃啥 投稿表单').getAttribute('src')).toContain(
      'restaurant_id=bayou-bbq&restaurant_name=Bayou+BBQ&source=restaurant-page',
    );
    expect(screen.getByRole('link', { name: '← Bayou BBQ' })).toHaveAttribute(
      'href',
      `${BASE}r/bayou-bbq/`,
    );
  });

  it('ignores unknown restaurant ids and still offers the general form', async () => {
    vi.stubEnv('VITE_TALLY_FORM', FORM);
    visit('submit/?restaurant=r-fake99');
    expect(
      await screen.findByRole('heading', { level: 1, name: '投稿：分享你的用餐体验' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('Rice吃啥 投稿表单').getAttribute('src')).not.toContain('r-fake99');
  });

  it('keeps the form usable when restaurant data cannot load', async () => {
    vi.stubEnv('VITE_TALLY_FORM', FORM);
    failIndex = true;
    visit('submit/?restaurant=bayou-bbq');
    expect(await screen.findByTitle('Rice吃啥 投稿表单')).toBeInTheDocument();
  });
});
