import { expect, test, type Page } from '@playwright/test';

// Fixture data (fixtures/restaurants): 11 published restaurants, 10 with coordinates, 1 draft.
const PUBLISHED = 11;
const WITH_LOCATION = 10;

test.beforeEach(async ({ page }) => {
  // Keep tests offline and avoid loading real map tiles.
  await page.route(/tile\.openstreetmap\.org/, (route) => route.abort());
  // The OpenStreetMap fallback is unavailable unless a test stubs it.
  await page.route(/^https:\/\/overpass-api\.de\//, (route) =>
    route.fulfill({ status: 429, body: '' }),
  );
  // The fixture build points at a fake Tally form (TALLY_FORM in build:e2e);
  // a stub page stands in for it, so no test depends on a real Tally account.
  // Like Tally, it tells the page once the form has rendered.
  await page.route(/^https:\/\/tally\.so\//, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>stub</title><p>Stub Tally form</p><p id="query">${new URL(route.request().url()).search}</p>
<script>parent.postMessage(JSON.stringify({ event: 'Tally.FormLoaded', payload: { formId: 'e2eForm' } }), '*');</script>`,
    }),
  );
});

const listNames = (page: Page) =>
  page.getByRole('list', { name: '餐厅列表' }).getByRole('heading', { level: 2 }).allTextContents();

const markers = (page: Page) => page.locator('.leaflet-marker-icon');
/** The map pane's offset: changes whenever the map pans. */
const mapOffset = (page: Page) =>
  page.locator('.leaflet-map-pane').evaluate((el) => (el as HTMLElement).style.transform);
/** Opens a filter, toggles options, and closes it again. */
async function filter(page: Page, button: RegExp, ...options: string[]) {
  await page.getByRole('button', { name: button }).click();
  const panel = page.locator('#filter-panel');
  for (const option of options)
    await panel.getByRole('button', { name: option, exact: true }).click();
  await panel.getByRole('button', { name: '完成' }).click();
}

test('search and multi-select filters update the list and the map, and live in the URL', async ({
  page,
}) => {
  await page.goto('/rice-eats/');
  await expect(page.getByText(`共 ${PUBLISHED} 家`)).toBeVisible();
  await expect(page.getByText('虚构的示例数据')).toBeVisible();
  expect(await listNames(page)).not.toContain('草稿餐厅（虚构示例）');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  // No view modes: the list and the map are always both there.
  await expect(page.getByRole('button', { name: '网格' })).toHaveCount(0);

  await filter(page, /^菜系/, '川菜', '日本菜');
  await expect(page).toHaveURL(/\?cuisine=japanese%2Csichuan$/);
  expect(await listNames(page)).toEqual(['蜀味小馆（虚构示例）', '灯笼拉面（虚构示例）']);
  await expect(markers(page)).toHaveCount(2);
  // Across dimensions every filter must match.
  await filter(page, /^标签/, '偏辣', '适合聚餐');
  expect(await listNames(page)).toEqual(['蜀味小馆（虚构示例）']);
  await expect(markers(page)).toHaveCount(1);

  await page.reload();
  await expect(page.getByText('找到 1 家 / 共 11 家')).toBeVisible();
  await expect(markers(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^菜系 \(2\)/ })).toBeVisible();

  await page.goBack();
  await expect(markers(page)).toHaveCount(2);
  await page.getByRole('button', { name: '清除全部' }).click();
  await expect(markers(page)).toHaveCount(WITH_LOCATION);

  await page.getByRole('searchbox').fill('拉面');
  expect(await listNames(page)).toEqual(['灯笼拉面（虚构示例）']);
  await expect(markers(page)).toHaveCount(1);
});

test('the price range and the sort work together without changing the map', async ({ page }) => {
  await page.goto('/rice-eats/');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  await page.getByRole('button', { name: /^人均/ }).click();
  // The slider (keyboard) and the typed fields both set the range.
  await page.getByRole('slider', { name: '最低人均' }).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\?min=15$/);
  await page.getByLabel('最高价（美元）').fill('30');
  await expect(page).toHaveURL(/\?min=15&max=30$/);
  // Unknown prices are not in a range.
  expect(await listNames(page)).toEqual([
    '河湾烤肉（虚构示例）',
    '蜀味小馆（虚构示例）',
    '灯笼拉面（虚构示例）',
  ]);
  await page.locator('#filter-panel').getByRole('button', { name: '完成' }).click();
  await expect(page.getByRole('button', { name: /^\$15–30/ })).toBeVisible();

  // Sorting reorders the list but leaves the map exactly where it was.
  await page.waitForTimeout(600);
  const before = await mapOffset(page);
  await page.getByLabel('排序').selectOption('price-desc');
  await expect(page).toHaveURL(/sort=price-desc/);
  expect(await listNames(page)).toEqual([
    '河湾烤肉（虚构示例）',
    '蜀味小馆（虚构示例）',
    '灯笼拉面（虚构示例）',
  ]);
  await page.getByLabel('排序').selectOption('price-asc');
  expect((await listNames(page))[0]).toBe('灯笼拉面（虚构示例）');
  await page.waitForTimeout(600);
  expect(await mapOffset(page)).toBe(before);
  await expect(markers(page)).toHaveCount(3);
});

test('distance sorting asks for the location only when chosen', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 29.7053, longitude: -95.5465 }); // at the Sichuan fixture
  await page.goto('/rice-eats/');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  await page.getByLabel('排序').selectOption('distance');
  await expect.poll(async () => (await listNames(page))[0]).toBe('蜀味小馆（虚构示例）');
  // The restaurant without a location comes last; distances are in miles.
  expect((await listNames(page)).at(-1)).toBe('流动餐车（虚构示例）');
  await expect(
    page
      .getByRole('list', { name: '餐厅列表' })
      .getByText(/· \d+(\.\d)? mi$/)
      .first(),
  ).toBeVisible();
  // The location never reaches the URL.
  expect(page.url()).not.toMatch(/29\.70|95\.54|lat|lng/);
});

test('using the map never changes the explorer', async ({ page }) => {
  await page.goto('/rice-eats/?tag=group&sort=name');
  await expect(markers(page)).toHaveCount(3);
  const names = await listNames(page);
  const map = page.getByRole('region', { name: '餐厅地图' });
  const box = (await map.boundingBox())!;
  // Drag and zoom (in the part of the map no sheet covers).
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + 120, { steps: 8 });
  await page.mouse.up();
  await map.getByRole('button', { name: 'Zoom out' }).click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\?tag=group&sort=name$/);
  expect(await listNames(page)).toEqual(names);
  await expect(markers(page)).toHaveCount(3);
});

test('map shows located restaurants and opens details from a marker', async ({ page }) => {
  await page.goto('/rice-eats/');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  await expect(page.getByText('1 家餐厅暂无位置信息')).toBeVisible();
  await expect(page.getByText('部分地图底图加载失败')).toBeVisible();
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');

  // Nearby markers overlap at this zoom, so select it with the keyboard
  // (Enter), as a screen reader or keyboard user would.
  const marker = page.getByRole('button', { name: '灯笼拉面（虚构示例）', exact: true });
  await marker.focus();
  await marker.press('Enter');
  await expect(page).toHaveURL(/id=fixture-lantern-noodles/);
  const preview = page.getByRole('region', { name: '灯笼拉面（虚构示例） 预览' });
  await expect(preview).toBeVisible();
  // The list is unchanged by the pin.
  await expect(page.getByText(`共 ${PUBLISHED} 家`)).toBeVisible();
  await preview.getByRole('link', { name: '查看详情' }).click();
  await expect(page).toHaveURL(/\/rice-eats\/r\/fixture-lantern-noodles\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('灯笼拉面（虚构示例）');
});

test('the list shows a restaurant on the map', async ({ page }) => {
  await page.goto('/rice-eats/');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  await page.getByRole('button', { name: '在地图上显示点心大堂（虚构示例）' }).click();
  await expect(page.locator('.leaflet-marker-icon.is-selected')).toHaveAttribute(
    'title',
    '点心大堂（虚构示例）',
  );
  const preview = page.getByRole('region', { name: '点心大堂（虚构示例） 预览' });
  await expect(preview).toBeVisible();
  // The selected pin is in view, not under the list or the sheet.
  const pin = (await page.locator('.leaflet-marker-icon.is-selected').boundingBox())!;
  const map = (await page.getByRole('region', { name: '餐厅地图' }).boundingBox())!;
  expect(pin.x).toBeGreaterThan(map.x);
  expect(pin.x + pin.width).toBeLessThan(map.x + map.width);
  const sheet = page.getByRole('region', { name: '餐厅列表面板' });
  const covered = (await sheet.count()) ? (await sheet.boundingBox())!.y : map.y + map.height;
  expect(pin.y + pin.height).toBeLessThan(covered);
  // A restaurant without a location cannot be located.
  await expect(page.getByRole('button', { name: '在地图上显示流动餐车（虚构示例）' })).toHaveCount(
    0,
  );
});

test('desktop: explorer and map side by side, the list scrolls on its own', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop layout');
  await page.goto('/rice-eats/');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  const explorer = (await page.getByRole('region', { name: '餐厅探索' }).boundingBox())!;
  const map = (await page.getByRole('region', { name: '餐厅地图' }).boundingBox())!;
  expect(explorer.x + explorer.width).toBeLessThanOrEqual(map.x + 1);
  expect(Math.abs(explorer.y - map.y)).toBeLessThan(2);
  // The page itself does not scroll; the list does.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  const list = page.getByRole('list', { name: '餐厅列表' }).locator('..');
  await list.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await page.getByRole('region', { name: '餐厅地图' }).boundingBox())!.y).toBe(map.y);
});

test('mobile: full-screen map with a three-state bottom sheet', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile layout');
  await page.goto('/rice-eats/?tag=group');
  await expect(markers(page)).toHaveCount(3);
  const sheet = page.getByRole('region', { name: '餐厅列表面板' });
  const map = page.getByRole('region', { name: '餐厅地图' });
  // The map fills the page behind the sheet, which starts half expanded.
  const mapBox = (await map.boundingBox())!;
  expect(mapBox.width).toBe(page.viewportSize()!.width);
  await expect(sheet).toHaveAttribute('data-state', 'half');
  await expect(sheet.getByRole('searchbox')).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^标签 \(1\)/ })).toBeVisible();

  // Drag the top bar up: expanded.
  const top = (await sheet.boundingBox())!;
  await page.mouse.move(top.x + 40, top.y + 12);
  await page.mouse.down();
  await page.mouse.move(top.x + 40, top.y - 250, { steps: 8 });
  await page.mouse.up();
  await expect(sheet).toHaveAttribute('data-state', 'expanded');
  // Scrolling the list inside does not move the sheet.
  await sheet.getByRole('list', { name: '餐厅列表' }).hover();
  await page.mouse.wheel(0, 300);
  await expect(sheet).toHaveAttribute('data-state', 'expanded');

  // Buttons work without gestures; the filters and list survive every state.
  await sheet.getByRole('button', { name: '看地图' }).click();
  await expect(sheet).toHaveAttribute('data-state', 'collapsed');
  // Leaflet still fills its container and the pins stay usable.
  expect((await map.boundingBox())!.height).toBeGreaterThan(400);
  await sheet.getByRole('button', { name: '展开', exact: true }).click();
  await expect(sheet).toHaveAttribute('data-state', 'half');
  await expect(page).toHaveURL(/\?tag=group$/);
  expect(await listNames(page)).toHaveLength(3);

  // The filter panel opens inside the sheet.
  await filter(page, /^评级/, '🥵 夯');
  expect(await listNames(page)).toEqual(['河湾烤肉（虚构示例）', '蜀味小馆（虚构示例）']);
  await expect(markers(page)).toHaveCount(2);
  // Focusing the search expands the sheet above the keyboard.
  await sheet.getByRole('searchbox').focus();
  await expect(sheet).toHaveAttribute('data-state', 'expanded');
});

test('restaurant pages render rich content and survive reloads', async ({ page }) => {
  const response = await page.goto('/rice-eats/r/fixture-dim-sum-hall/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('点心大堂（虚构示例）');
  const review = page.getByRole('region', { name: '点评' });
  await expect(review.locator('figure img')).toHaveCount(3);
  await expect(review.locator('figcaption').first()).toHaveText('虾饺（示例图注）');
  await expect(review.getByRole('heading', { level: 2, name: '早茶时间' })).toBeVisible();

  // Every image on the page loads from the /rice-eats/ base path.
  const images = page.locator('img');
  for (const src of await images.evaluateAll((els) =>
    els.map((el) => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src),
  )) {
    expect(new URL(src).pathname).toMatch(/^\/rice-eats\//);
  }
  await review.locator('figure img').last().scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      review
        .locator('figure img')
        .last()
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  await page.getByRole('link', { name: '← 全部餐厅' }).click();
  await expect(page).toHaveURL(/\/rice-eats\/$/);
});

test('photo-only restaurants show their photos; same-name restaurants stay separate', async ({
  page,
}) => {
  await page.goto('/rice-eats/r/fixture-photo-only/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('只有照片的小店（虚构示例）');
  await expect(
    page.getByRole('img', { name: '只有照片的小店（虚构示例）', exact: true }),
  ).toBeVisible(); // cover
  await expect(page.getByRole('region', { name: '照片' }).getByRole('img')).toHaveCount(2);
  await expect(page.getByRole('link', { name: /Google 地图导航/ })).toHaveAttribute(
    'href',
    /google\.com\/maps/,
  );
  await expect(page.getByRole('link', { name: /Apple 地图导航/ })).toHaveAttribute(
    'href',
    /maps\.apple\.com/,
  );

  await page.goto('/rice-eats/?q=街角塔可');
  await expect(page.getByText('找到 2 家 / 共 11 家')).toBeVisible();
  const links = page.getByRole('list', { name: '餐厅列表' }).getByRole('link');
  const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(new Set(hrefs).size).toBe(2);
});

test('unknown pages and drafts are not found', async ({ page }) => {
  const draft = await page.goto('/rice-eats/r/fixture-draft-only/');
  expect(draft?.status()).toBe(404);
  await expect(page.getByText('找不到这家餐厅')).toBeVisible();
  const missing = await page.goto('/rice-eats/nowhere');
  expect(missing?.status()).toBe(404);
  await expect(page.getByText('页面不存在')).toBeVisible();
  expect(
    (await page.request.get('/rice-eats/generated/restaurants/fixture-draft-only.json')).status(),
  ).toBe(404);
});

test('layout fits the viewport without horizontal scrolling', async ({ page }) => {
  for (const url of [
    '/rice-eats/',
    '/rice-eats/?view=grid',
    '/rice-eats/?view=map',
    '/rice-eats/r/fixture-sichuan-house/',
    '/rice-eats/submit/',
  ]) {
    await page.goto(url);
    await expect(page.getByRole('main')).not.toBeEmpty();
    await page.waitForLoadState('networkidle');
    // Compare with the device viewport: on phones, content wider than the screen
    // also widens window.innerWidth (the page gets zoomed out), hiding overflow.
    const width = page.viewportSize()!.width;
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth, url).toBeLessThanOrEqual(width);
  }
});

test('keyboard users can reach search, filters, and restaurants', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'keyboard navigation is a desktop concern');
  await page.goto('/rice-eats/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await page.getByRole('searchbox').focus();
  await page.keyboard.type('河粉');
  expect(await listNames(page)).toEqual(['河粉花园（虚构示例）']);
  await page.getByRole('button', { name: /^菜系/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#filter-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#filter-panel')).toHaveCount(0);
  await page.getByRole('link', { name: /河粉花园/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('河粉花园（虚构示例）');
});

/** Fake restaurants for the Geoapify stub: one near Rice, one farther north-east. */
const FAKE_PLACES = [
  {
    place_id: 'e2e-place',
    name: 'Fake Noodle Bar',
    address_line2: '1 Fake St',
    lat: 29.7184,
    lon: -95.4018,
  },
  {
    place_id: 'e2e-taco',
    name: 'Fake Taco Stop',
    address_line2: '2 Fake St',
    lat: 29.7352,
    lon: -95.3897,
  },
];

/** A fake Geoapify Places API: the fake places inside a rectangle, or one named after the query. */
async function fakePlaces(page: Page, fixtures = FAKE_PLACES) {
  const requests: URL[] = [];
  await page.route(/^https:\/\/api\.geoapify\.com\//, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/v1/geocode/')) {
      // A fake Geocoding API: one address, near Rice Village.
      return route.fulfill({
        json: {
          results: [
            {
              place_id: 'e2e-geocode',
              address_line1: '2111 Norfolk St',
              address_line2: 'Houston, TX 77098, United States',
              housenumber: '2111',
              result_type: 'building',
              lat: 29.7333,
              lon: -95.4123,
            },
          ],
        },
      });
    }
    requests.push(url);
    const filter = url.searchParams.get('filter')!;
    const name = url.searchParams.get('name');
    let places = fixtures;
    if (name) places = [{ ...fixtures[0]!, place_id: 'e2e-named', name: `${name} Kitchen` }];
    else if (filter.startsWith('rect:')) {
      const [w, s, e, n] = filter.slice(5).split(',').map(Number) as [
        number,
        number,
        number,
        number,
      ];
      places = fixtures.filter((p) => p.lon >= w && p.lon < e && p.lat >= s && p.lat < n);
    }
    return route.fulfill({ json: { features: places.map((properties) => ({ properties })) } });
  });
  return requests;
}

const NEXT = '下一步：填写点评 →';
const pin = (page: Page, name: string) => page.locator(`.leaflet-marker-icon[title="${name}"]`);

const formQuery = (page: Page) =>
  page.frameLocator('iframe[title="Rice Eats 投稿表单"]').locator('#query');

test('visitors pick a restaurant from the map around Rice before the form loads', async ({
  page,
}) => {
  const places = await fakePlaces(page);
  const response = await page.goto('/rice-eats/submit/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('投稿：分享你的用餐体验');
  await expect(page.getByText(/不会立即出现在网站上/)).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '搜索地图中心附近' })).toHaveCount(0);

  // Restaurants around Rice load as pins without any action.
  await expect(page.getByText('地图上有 1 家餐厅，点图钉选择。')).toBeVisible();
  const rects = places.filter((u) => u.searchParams.get('filter')!.startsWith('rect:'));
  expect(rects.length).toBeGreaterThan(0);
  expect(rects[0]!.searchParams.get('categories')).toContain('catering.restaurant');
  await expect(page.getByText('第一步 · 选择餐厅')).toBeVisible();
  // Names are on the map without clicking.
  await expect(pin(page, 'Fake Noodle Bar').locator('.poi-label')).toHaveText('Fake Noodle Bar');
  await pin(page, 'Fake Noodle Bar').click();

  // Selected in place: highlighted pin and details below the map, no confirmation page.
  await expect(pin(page, 'Fake Noodle Bar')).toHaveClass(/is-selected/);
  const selected = page.getByRole('region', { name: '已选餐厅' });
  await expect(selected).toContainText('Fake Noodle Bar');
  await expect(selected).toContainText('1 Fake St');
  await expect(page.getByRole('button', { name: '确认餐厅' })).toHaveCount(0);
  await page.getByRole('button', { name: NEXT }).click();
  await expect(page.getByText('第二步 · 填写点评')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('为「Fake Noodle Bar」投稿');
  await expect(page.getByText(/在新窗口打开投稿表单/)).toHaveCount(0);
  const query = formQuery(page);
  await expect(query).toContainText('restaurant_name=Fake+Noodle+Bar');
  await expect(query).toContainText('restaurant_lat=29.718400&restaurant_lng=-95.401800');
  await expect(query).toContainText('poi_provider=geoapify&poi_id=e2e-place');
  await expect(query).toContainText('selection_method=poi&source=site');
});

/** Label boxes of the pins on the map, and the map's box. */
async function labelBoxes(page: Page) {
  const map = (await page.getByRole('region', { name: '附近餐厅地图' }).boundingBox())!;
  const labels = await page.locator('.poi-label').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        name: el.textContent ?? '',
        selected: !!el.closest('.is-selected'),
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      };
    }),
  );
  return { map, labels };
}

test('pin names stay readable, inside the map, and follow the map', async ({ page }) => {
  // A dense block next to Rice, long names, and a restaurant at the map's east edge.
  const dense = Array.from({ length: 12 }, (_, i) => ({
    place_id: `e2e-dense-${i}`,
    name: i % 2 ? `川味小馆 ${i}号店` : `The Long Named Neighborhood Bistro ${i}`,
    address_line2: `${i} Dense St`,
    lat: 29.7174 + (i % 4) * 0.0002,
    lon: -95.4018 + Math.floor(i / 4) * 0.0003,
  }));
  await fakePlaces(page, [...FAKE_PLACES, ...dense]);
  await page.goto('/rice-eats/submit/');
  await expect(page.locator('.poi-label').first()).toBeVisible();
  const check = async () => {
    const { map, labels } = await labelBoxes(page);
    expect(labels.length).toBeGreaterThan(1);
    for (const l of labels) {
      expect(l.left).toBeGreaterThanOrEqual(map.x - 1);
      expect(l.right).toBeLessThanOrEqual(map.x + map.width + 1);
    }
    // No two names overlap.
    for (const [i, a] of labels.entries()) {
      for (const b of labels.slice(i + 1)) {
        const overlap =
          a.left < b.right - 1 &&
          b.left < a.right - 1 &&
          a.top < b.bottom - 1 &&
          b.top < a.bottom - 1;
        expect(overlap, `${a.name} / ${b.name}`).toBe(false);
      }
    }
    return labels;
  };
  await check();

  // Every restaurant in view can be read and chosen from the list.
  await page.getByText(/按列表查看这 \d+ 家餐厅/).click();
  const list = page.getByRole('list', { name: '地图上的餐厅' });
  await expect(list.getByRole('button')).toHaveCount(13);
  await list.getByRole('button', { name: /川味小馆 7号店/ }).click();
  const selectedPin = pin(page, '川味小馆 7号店');
  await expect(selectedPin).toHaveClass(/is-selected/);
  // The selected name is always shown, whatever crowds it.
  await expect(selectedPin.locator('.poi-label')).toHaveText('川味小馆 7号店');
  await check();

  // After zooming out and panning, the layout follows the map.
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.locator('.poi-label')).not.toHaveCount(0);
  await page.waitForTimeout(500); // the zoom animation
  const map = page.getByRole('region', { name: '附近餐厅地图' });
  const box = (await map.boundingBox())!;
  // Pan the map (with the keyboard, 80 px a step) until the selected
  // restaurant is near its right edge.
  const pinBox = (await selectedPin.boundingBox())!;
  const steps = Math.floor((box.x + box.width - 14 - (pinBox.x + pinBox.width / 2)) / 80);
  await map.focus();
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('ArrowLeft');
    // Leaflet ignores arrow keys while the previous pan is animating.
    await page.waitForTimeout(400);
  }
  await expect(selectedPin.locator('.poi-label')).toHaveClass(/is-left/);
  const labels = await check();
  expect(labels.some((l) => l.selected && l.name === '川味小馆 7号店')).toBe(true);
});

test('visitors locate the search area by preset or address before choosing', async ({ page }) => {
  const places = await fakePlaces(page);
  await page.goto('/rice-eats/submit/');
  const area = page.getByRole('region', { name: '选择查找区域' });
  await expect(area.getByText('当前查找区域：Rice University 周边')).toBeVisible();
  await expect(page.getByText(/地图上有 \d+ 家餐厅/)).toBeVisible();

  // Chinatown: the map moves to Bellaire Blvd and looks for restaurants there.
  await area.getByRole('button', { name: 'Chinatown 周边' }).click();
  await expect(area.getByText('当前查找区域：Chinatown 周边')).toBeVisible();
  await expect
    .poll(() =>
      places.some((u) => {
        const filter = u.searchParams.get('filter') ?? '';
        const west = Number(filter.slice(5).split(',')[0]);
        return filter.startsWith('rect:') && west < -95.55 && west > -95.58;
      }),
    )
    .toBe(true);
  await expect(page.getByRole('region', { name: '已选餐厅' })).toHaveCount(0);

  // An address: searched on Enter, the map moves there, nothing is selected.
  await area.getByRole('searchbox', { name: '输入地址或地点' }).fill('2111 Norfolk');
  await area.getByRole('searchbox', { name: '输入地址或地点' }).press('Enter');
  await expect(area.getByText('当前查找区域：2111 Norfolk St')).toBeVisible();
  await expect(page.getByRole('region', { name: '已选餐厅' })).toHaveCount(0);
  await expect(page.getByText(/搜索地图中心约 3.1 mi 范围内的餐厅/)).toBeVisible();
});

test('late address and location answers never override the latest choice', async ({ page }) => {
  const places = await fakePlaces(page);
  // A slow geocoder: answers only when the test releases it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const geocodeRequests: string[] = [];
  await page.route(/^https:\/\/api\.geoapify\.com\/v1\/geocode\//, async (route) => {
    geocodeRequests.push(route.request().url());
    await held;
    await route
      .fulfill({
        json: {
          results: [
            {
              place_id: 'e2e-late',
              address_line1: '2111 Norfolk St',
              address_line2: 'Houston, TX 77098',
              lat: 29.7333,
              lon: -95.4123,
            },
          ],
        },
      })
      .catch(() => {}); // the page may have cancelled the request
  });
  // A slow device location: the test decides when it answers.
  await page.addInitScript(() => {
    const pending: PositionCallback[] = [];
    Object.assign(window, {
      __locate: () =>
        pending.shift()?.({
          coords: { latitude: 29.76, longitude: -95.37 },
        } as GeolocationPosition),
    });
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition: (ok: PositionCallback) => pending.push(ok) },
    });
  });
  const nominatim: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('nominatim')) nominatim.push(r.url());
  });

  await page.goto('/rice-eats/submit/');
  const area = page.getByRole('region', { name: '选择查找区域' });
  const status = area.getByText(/^当前查找区域：/);
  await expect(status).toHaveText('当前查找区域：Rice University 周边');

  // Address search pending, location pending, then Chinatown.
  await area.getByRole('searchbox', { name: '输入地址或地点' }).fill('2111 Norfolk');
  await area.getByRole('searchbox', { name: '输入地址或地点' }).press('Enter');
  await expect(area.getByText('正在搜索地点…')).toBeVisible();
  await area.getByRole('button', { name: '使用当前位置' }).click();
  await area.getByRole('button', { name: 'Chinatown 周边' }).click();
  await expect(status).toHaveText('当前查找区域：Chinatown 周边');

  // The late answers arrive out of order: the location, then the address.
  await page.evaluate(() => (window as unknown as { __locate: () => void }).__locate());
  release();
  await page.waitForTimeout(1500);
  await expect(status).toHaveText('当前查找区域：Chinatown 周边');
  await expect(area.getByRole('list', { name: '地点搜索结果' })).toHaveCount(0);
  // The map really stayed at Chinatown: the last restaurant tiles requested are there.
  const west = (u: URL) => Number(u.searchParams.get('filter')!.slice(5).split(',')[0]);
  const rects = places.filter((u) => u.searchParams.get('filter')!.startsWith('rect:'));
  expect(west(rects.at(-1)!)).toBeLessThan(-95.54);
  expect(geocodeRequests).toHaveLength(1);
  expect(nominatim).toEqual([]);
});

test('dragging or zooming the map by hand wins over a late address', async ({ page }) => {
  const places = await fakePlaces(page);
  // A slow geocoder whose answer (Sugar Land) is far from Rice.
  let release = () => {};
  await page.route(/^https:\/\/api\.geoapify\.com\/v1\/geocode\//, async (route) => {
    const text = new URL(route.request().url()).searchParams.get('text');
    if (text !== 'Slow Place') await new Promise<void>((resolve) => (release = resolve));
    await route
      .fulfill({
        json: {
          results: [
            {
              place_id: `e2e-${text}`,
              address_line1: text,
              address_line2: 'Sugar Land, TX',
              lat: 29.62,
              lon: -95.63,
            },
          ],
        },
      })
      .catch(() => {});
  });
  await page.goto('/rice-eats/submit/');
  const area = page.getByRole('region', { name: '选择查找区域' });
  const status = area.getByText(/^当前查找区域：/);
  const search = area.getByRole('searchbox', { name: '输入地址或地点' });
  const map = page.getByRole('region', { name: '附近餐厅地图' });
  await expect(page.getByText(/地图上有 \d+ 家餐厅/)).toBeVisible();
  const west = (u: URL) => Number(u.searchParams.get('filter')!.slice(5).split(',')[0]);
  const lastTileWest = () =>
    west(places.filter((u) => u.searchParams.get('filter')!.startsWith('rect:')).at(-1)!);
  const settle = () => page.waitForTimeout(1200);

  const gestures: [string, () => Promise<void>][] = [
    [
      'drag',
      async () => {
        await map.scrollIntoViewIfNeeded();
        const box = (await map.boundingBox())!;
        // Away from the pins (near the center), which take their own clicks.
        await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height - 40);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height - 70, { steps: 8 });
        await page.mouse.up();
      },
    ],
    [
      'wheel zoom',
      async () => {
        await map.scrollIntoViewIfNeeded();
        const box = (await map.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -200);
      },
    ],
    [
      'zoom button',
      async () => {
        await map.getByRole('button', { name: 'Zoom out' }).click();
      },
    ],
    [
      'keyboard pan',
      async () => {
        await map.focus();
        await page.keyboard.press('ArrowRight');
      },
    ],
  ];
  for (const [name, gesture] of gestures) {
    await search.fill(`Late ${name}`);
    await search.press('Enter');
    await expect(area.getByText('正在搜索地点…')).toBeVisible();
    await gesture();
    // The gesture ends the pending search at once.
    await expect(area.getByText('正在搜索地点…'), name).toHaveCount(0);
    release();
    await settle();
    // The late answer did not move the map to Sugar Land.
    await expect(status, name).not.toContainText(`Late ${name}`);
    expect(lastTileWest(), name).toBeGreaterThan(-95.5);
  }

  // Programmatic moves still apply and are not taken for gestures.
  await search.fill('Slow Place');
  await search.press('Enter');
  await expect(status).toHaveText('当前查找区域：Slow Place');
  await expect.poll(lastTileWest).toBeLessThan(-95.6);
  await area.getByRole('button', { name: 'Chinatown 周边' }).click();
  await expect(status).toHaveText('当前查找区域：Chinatown 周边');
  await expect.poll(lastTileWest).toBeGreaterThan(-95.58);
});

test('the current location moves the map and the pins follow', async ({ page, context }) => {
  await fakePlaces(page);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 29.7352, longitude: -95.3895 });
  await page.goto('/rice-eats/submit/');
  await expect(pin(page, 'Fake Noodle Bar')).toBeVisible();
  await page.getByRole('button', { name: '使用当前位置' }).click();
  await expect(pin(page, 'Fake Taco Stop')).toBeVisible();
  await expect(pin(page, 'Fake Noodle Bar')).toHaveCount(0);
  await pin(page, 'Fake Taco Stop').click();
  await page.getByRole('button', { name: NEXT }).click();
  const query = formQuery(page);
  await expect(query).toContainText('restaurant_lat=29.735200');
  // The device position itself is never submitted.
  await expect(query).not.toContainText('29.735200&restaurant_lng=-95.389500');
  await expect(query).not.toContainText('-95.389500');
});

test('visitors without location permission can still explore the map or search by name', async ({
  page,
}) => {
  await fakePlaces(page);
  await page.goto('/rice-eats/submit/');
  await page.getByRole('button', { name: '使用当前位置' }).click();
  await expect(page.getByText(/没有获得定位权限|暂时无法获取当前位置/)).toBeVisible();
  await expect(pin(page, 'Fake Noodle Bar')).toBeVisible();

  await page.getByRole('searchbox', { name: '在当前区域搜索餐厅' }).fill('Dumpling');
  const result = page
    .getByRole('list', { name: '搜索结果' })
    .getByRole('button', { name: /Dumpling Kitchen/ });
  // Distances are in miles.
  await expect(result).toContainText(/\d mi$/);
  await result.click();
  await expect(page.getByRole('region', { name: '已选餐厅' })).toContainText('Dumpling Kitchen');
  await expect(pin(page, 'Dumpling Kitchen')).toHaveClass(/is-selected/);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('the map falls back to OpenStreetMap when Geoapify is out of credits', async ({ page }) => {
  await page.route(/^https:\/\/api\.geoapify\.com\//, (route) =>
    route.fulfill({ status: 429, body: '' }),
  );
  await page.route(/^https:\/\/overpass-api\.de\//, (route) => {
    const query = new URLSearchParams(route.request().postData() ?? '').get('data') ?? '';
    const [s, w, n, e] = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/
      .exec(query)!
      .slice(1)
      .map(Number) as [number, number, number, number];
    const elements = FAKE_PLACES.filter(
      (p) => p.lat >= s && p.lat < n && p.lon >= w && p.lon < e,
    ).map((p, i) => ({
      type: 'node',
      id: 500 + i,
      lat: p.lat,
      lon: p.lon,
      tags: { name: p.name },
    }));
    return route.fulfill({ json: { elements } });
  });
  await page.goto('/rice-eats/submit/');
  await pin(page, 'Fake Noodle Bar').click();
  await page.getByRole('button', { name: NEXT }).click();
  const query = formQuery(page);
  await expect(query).toContainText('restaurant_name=Fake+Noodle+Bar');
  await expect(query).toContainText('poi_provider=osm&poi_id=node%2F500');
});

test('visitors can add a restaurant by hand when search fails', async ({ page }) => {
  await page.route(/^https:\/\/api\.geoapify\.com\//, (route) =>
    route.fulfill({ status: 429, body: '' }),
  );
  await page.goto('/rice-eats/submit/');
  await expect(page.getByText(/餐厅搜索暂时不可用/)).toBeVisible();

  await page.getByRole('button', { name: '手动添加餐厅' }).click();
  await page.getByLabel('餐厅名称').fill('新开的面馆');
  await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();
  await page
    .getByRole('region', { name: '标出餐厅位置的地图' })
    .click({ position: { x: 150, y: 100 } });
  await expect(page.getByText('已标出位置，可以再点一下修改。')).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: NEXT }).click();
  const query = formQuery(page);
  await expect(query).toContainText(
    'restaurant_name=%E6%96%B0%E5%BC%80%E7%9A%84%E9%9D%A2%E9%A6%86',
  );
  await expect(query).toContainText('restaurant_lat=29.');
  await expect(query).toContainText('selection_method=manual');
  await expect(query).not.toContainText('poi_id');

  // Name only: allowed, and marked for location checking.
  await page.getByRole('button', { name: '更换餐厅' }).click();
  await page.getByRole('button', { name: '手动添加餐厅' }).click();
  await page.getByLabel('餐厅名称').fill('Mystery Diner');
  await page.getByLabel(/我不确定具体位置/).check();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText(/没有位置信息/)).toBeVisible();
  await page.getByRole('button', { name: NEXT }).click();
  await expect(query).toContainText(
    'restaurant_name=Mystery+Diner&selection_method=manual&source=site',
  );
});

test('a restaurant page passes its restaurant to the form', async ({ page }) => {
  await page.goto('/rice-eats/r/fixture-sichuan-house/');
  await page.getByRole('link', { name: '补充点评或照片' }).click();
  await expect(page).toHaveURL(/\/rice-eats\/submit\/\?restaurant=fixture-sichuan-house$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    '为「蜀味小馆（虚构示例）」投稿',
  );
  const query = formQuery(page);
  await expect(
    page.frameLocator('iframe[title="Rice Eats 投稿表单"]').getByText('Stub Tally form'),
  ).toBeVisible();
  await expect(query).toContainText('restaurant_id=fixture-sichuan-house');
  await expect(query).toContainText('restaurant_lat=29.705300&restaurant_lng=-95.546500');
  await expect(query).toContainText('selection_method=existing&source=restaurant-page');
  await expect(page.getByText('第二步 · 填写点评')).toBeVisible();
  // Tally reports the form loaded: no loading note and no fallback link.
  await expect(page.getByText('正在加载投稿表单…')).toHaveCount(0);
  await expect(page.getByText(/在新窗口打开投稿表单/)).toHaveCount(0);

  await page.getByRole('button', { name: '更换餐厅' }).click();
  await expect(page.getByText('第一步 · 选择餐厅')).toBeVisible();
  await expect(page.getByRole('region', { name: '已选餐厅' })).toContainText('蜀味小馆');
  await page.getByRole('link', { name: '投稿', exact: true }).click();
  await expect(page).toHaveURL(/\/rice-eats\/submit\/$/);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('the form offers recovery when Tally does not load', async ({ page }) => {
  // Tally answers with a page that never reports a loaded form (like its
  // error page): the iframe still fires its load event.
  let broken = true;
  await page.route(/^https:\/\/tally\.so\//, (route) =>
    broken
      ? route.fulfill({ status: 503, contentType: 'text/html', body: '<p>Service unavailable</p>' })
      : route.fallback(),
  );
  await page.clock.install();
  await page.goto('/rice-eats/submit/?restaurant=fixture-sichuan-house');
  await expect(page.getByText('正在加载投稿表单…')).toBeVisible();
  await expect(page.getByText(/在新窗口打开投稿表单/)).toHaveCount(0);
  await page.clock.fastForward(11000);
  await expect(page.getByText(/表单好像没有正常加载/)).toBeVisible();
  const link = page.getByRole('link', { name: /在新窗口打开投稿表单/ });
  const direct = new URL((await link.getAttribute('href'))!);
  expect(direct.pathname).toBe('/r/e2eForm');
  expect(direct.searchParams.get('restaurant_id')).toBe('fixture-sichuan-house');
  expect(direct.searchParams.get('source')).toBe('restaurant-page');
  expect(direct.searchParams.has('hideTitle')).toBe(false);

  // Once Tally works again, reloading shows the form and clears the notice.
  broken = false;
  await page.getByRole('button', { name: '重新加载表单' }).click();
  await expect(
    page.frameLocator('iframe[title="Rice Eats 投稿表单"]').getByText('Stub Tally form'),
  ).toBeVisible();
  await expect(page.getByText('正在加载投稿表单…')).toHaveCount(0);
  await page.clock.fastForward(11000);
  await expect(page.getByText(/表单好像没有正常加载/)).toHaveCount(0);
});

test('the form does not load on other pages', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tally.so')) requests.push(request.url());
  });
  await page.goto('/rice-eats/');
  await expect(page.getByText(`共 ${PUBLISHED} 家`)).toBeVisible();
  await page.goto('/rice-eats/r/fixture-dim-sum-hall/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(requests).toEqual([]);
});

test('keyboard users can reach the submission entry and the step controls', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'keyboard navigation is a desktop concern');
  await page.goto('/rice-eats/');
  await expect(page.getByText(`共 ${PUBLISHED} 家`)).toBeVisible();
  const entry = page.getByRole('link', { name: '投稿', exact: true });
  for (let i = 0; i < 5 && !(await entry.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(entry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/rice-eats\/submit\/$/);
  const locate = page.getByRole('button', { name: '使用当前位置' });
  for (let i = 0; i < 10 && !(await locate.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(locate).toBeFocused();

  await page.goto('/rice-eats/submit/?restaurant=fixture-sichuan-house');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    '为「蜀味小馆（虚构示例）」投稿',
  );
  const change = page.getByRole('button', { name: '更换餐厅' });
  for (let i = 0; i < 10 && !(await change.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(change).toBeFocused();
});
