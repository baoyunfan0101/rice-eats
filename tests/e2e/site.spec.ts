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
  // Both handles move with the keyboard; their values ride on them.
  await page.getByRole('slider', { name: '最低人均' }).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\?min=15$/);
  await page.getByRole('slider', { name: '最高人均' }).focus();
  for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/\?min=15&max=30$/);
  // Close values share one tag.
  await expect(page.locator('#filter-panel').getByText('$15–30')).toBeVisible();
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

test('a price beyond the slider reads as it is and can be lowered by dragging', async ({
  page,
}) => {
  await page.goto('/rice-eats/?min=150');
  await expect(page.getByText('没有符合条件的餐厅')).toBeVisible();
  await page.getByRole('button', { name: /^\$150 以上/ }).click();
  const panel = page.locator('#filter-panel');
  await expect(panel.getByText('$150+')).toBeVisible();
  // Both handles sit at the end; the lower one is on top and drags back.
  const slider = (await panel.getByRole('slider', { name: '最低人均' }).boundingBox())!;
  await page.mouse.move(slider.x + slider.width - 10, slider.y + slider.height / 2);
  await page.mouse.down();
  await page.mouse.move(slider.x + slider.width * 0.25, slider.y + slider.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\?min=2\d$/);
  await expect(markers(page)).not.toHaveCount(0);
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

test('distance sorting follows the last choice whatever order locations answer in', async ({
  page,
}) => {
  // A geolocation whose requests answer only when the test says so.
  await page.addInitScript(() => {
    const requests: { ok: PositionCallback; fail: PositionErrorCallback }[] = [];
    Object.assign(window, {
      __locations: {
        count: () => requests.length,
        succeed: (i: number, latitude: number, longitude: number) =>
          requests[i]!.ok({ coords: { latitude, longitude } } as GeolocationPosition),
        deny: (i: number) =>
          requests[i]!.fail({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError),
      },
    });
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: (ok: PositionCallback, fail: PositionErrorCallback) =>
          requests.push({ ok, fail }),
      },
    });
  });
  type Locations = {
    count: () => number;
    succeed: (i: number, lat: number, lng: number) => void;
    deny: (i: number) => void;
  };
  const locations = {
    count: () =>
      page.evaluate(() => (window as unknown as { __locations: Locations }).__locations.count()),
    succeed: (i: number, lat: number, lng: number) =>
      page.evaluate(
        ([i, lat, lng]) =>
          (window as unknown as { __locations: Locations }).__locations.succeed(i!, lat!, lng!),
        [i, lat, lng],
      ),
    deny: (i: number) =>
      page.evaluate(
        (i) => (window as unknown as { __locations: Locations }).__locations.deny(i),
        i,
      ),
  };
  await page.goto('/rice-eats/?sort=name');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  await page.waitForTimeout(500);
  const offset = await mapOffset(page);
  const sort = page.getByLabel('排序');

  // Distance (A), name, distance again (B); then A fails late and B succeeds.
  await sort.selectOption('distance');
  await sort.selectOption('name');
  await sort.selectOption('distance');
  expect(await locations.count()).toBe(2);
  await locations.deny(0);
  await expect(sort).toHaveValue('distance');
  await expect(page.getByText(/没有获得定位权限/)).toHaveCount(0);
  await locations.succeed(1, 29.7053, -95.5465); // at the Sichuan fixture
  await expect.poll(async () => (await listNames(page))[0]).toBe('蜀味小馆（虚构示例）');

  // Distance (C), then price: C succeeding late changes nothing.
  await sort.selectOption('price-asc');
  const byPrice = await listNames(page);
  await sort.selectOption('distance');
  await sort.selectOption('price-asc');
  await locations.succeed(2, 29.75, -95.36);
  await expect(sort).toHaveValue('price-asc');
  expect(await listNames(page)).toEqual(byPrice);
  // The map never moved, and the location never reached the URL.
  expect(await mapOffset(page)).toBe(offset);
  expect(page.url()).toMatch(/\?sort=price-asc$/);
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

/** The map's current zoom, from the tiles of its front tile layer. */
const mapZoom = (page: Page) =>
  page.evaluate(() => {
    const levels = [...document.querySelectorAll<HTMLElement>('.leaflet-tile-container')];
    const front = levels.sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0];
    const src = front?.querySelector('img')?.getAttribute('src') ?? '';
    return Number(/\/(\d+)\/\d+\/\d+\.png/.exec(src)?.[1]);
  });

test('a map gesture during the refit delay wins over the pending refit', async ({ page }) => {
  // The page's clock is paused while the results change and the gesture
  // happens, so a slow machine cannot let the refit delay pass in between.
  await page.clock.install();
  await page.goto('/rice-eats/');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  await page.waitForTimeout(500);
  const map = page.getByRole('region', { name: '餐厅地图' });
  const box = (await map.boundingBox())!;
  // Fitting one restaurant zooms to 15; the overview of all is much further out.
  const overview = await mapZoom(page);
  expect(overview).toBeLessThan(14);
  let at = Date.now() + 60_000;
  const paused = async (act: () => Promise<void>) => {
    await page.clock.pauseAt(new Date((at += 60_000)));
    await act();
    await page.clock.resume();
    await page.waitForTimeout(1200);
  };

  // Change the results (one restaurant), then drag.
  await paused(async () => {
    await page.getByRole('searchbox').fill('拉面');
    await page.mouse.move(box.x + box.width / 2, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 160, box.y + 80, { steps: 4 });
    await page.mouse.up();
  });
  await expect(markers(page)).toHaveCount(1);
  // The pending refit was dropped: the zoom is still the overview's.
  expect(await mapZoom(page)).toBe(overview);

  // Change the results, then use the zoom buttons.
  await paused(async () => {
    await page.getByRole('searchbox').fill('蜀味');
    await map.getByRole('button', { name: 'Zoom out' }).click();
  });
  await expect(markers(page)).toHaveCount(1);
  expect(await mapZoom(page)).toBe(overview - 1);

  // Without a gesture, a change of results refits to the one restaurant.
  await page.getByRole('searchbox').fill('灯笼');
  await expect.poll(() => mapZoom(page), { timeout: 3000 }).toBe(15);
});

test('map shows located restaurants and opens details from a marker', async ({ page }) => {
  await page.goto('/rice-eats/?sort=name');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  await expect(page.getByText('1 家餐厅暂无位置信息')).toBeVisible();
  await expect(page.getByText('部分地图底图加载失败')).toBeVisible();
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
  // Pins with room for it carry the cover thumbnail and the name.
  await expect(page.locator('.poi-label.has-thumb').first()).toBeVisible();
  await expect(page.locator('.poi-label img.poi-thumb').first()).toHaveAttribute(
    'src',
    /^\/rice-eats\//,
  );

  // Nearby markers overlap at this zoom, so select it with the keyboard
  // (Enter), as a screen reader or keyboard user would.
  const marker = page.locator('.leaflet-marker-icon[title="灯笼拉面（虚构示例）"]');
  const offset = await mapOffset(page);
  await marker.focus();
  await marker.press('Enter');
  // The details open in the list area, keeping the browse state; the map
  // selects the pin and stays where it was.
  await expect(page).toHaveURL(/\/rice-eats\/r\/fixture-lantern-noodles\/\?sort=name$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('灯笼拉面（虚构示例）');
  await expect(page.locator('.leaflet-marker-icon.is-selected')).toHaveAttribute(
    'title',
    '灯笼拉面（虚构示例）',
  );
  await expect(page.locator('.leaflet-marker-icon.is-selected .poi-label')).toBeVisible();
  expect(await mapOffset(page)).toBe(offset);
  await expect(page.getByRole('list', { name: '餐厅列表' })).toBeHidden();
  // Back to the list as it was.
  await page.getByRole('button', { name: '← 返回列表' }).click();
  await expect(page).toHaveURL(/\/rice-eats\/\?sort=name&id=fixture-lantern-noodles$/);
  await expect(page.getByText(`共 ${PUBLISHED} 家`)).toBeVisible();
});

test('opening a restaurant from the list selects it on the map, in view', async ({ page }) => {
  await page.goto('/rice-eats/');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  // No separate map buttons on the cards.
  await expect(page.getByRole('list', { name: '餐厅列表' }).getByRole('button')).toHaveCount(0);
  await page
    .getByRole('list', { name: '餐厅列表' })
    .getByRole('link', { name: '点心大堂（虚构示例）' })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('点心大堂（虚构示例）');
  await expect(page.locator('.leaflet-marker-icon.is-selected')).toHaveAttribute(
    'title',
    '点心大堂（虚构示例）',
  );
  await page.waitForTimeout(400);
  // The selected pin is in view, not under the list or the sheet.
  const pin = (await page.locator('.leaflet-marker-icon.is-selected').boundingBox())!;
  const map = (await page.getByRole('region', { name: '餐厅地图' }).boundingBox())!;
  expect(pin.x).toBeGreaterThan(map.x);
  expect(pin.x + pin.width).toBeLessThan(map.x + map.width);
  const sheet = page.getByRole('region', { name: '餐厅列表面板' });
  const covered = (await sheet.count()) ? (await sheet.boundingBox())!.y : map.y + map.height;
  expect(pin.y + pin.height).toBeLessThan(covered);
});

test('pointing at a restaurant in the list highlights its pin', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'needs a mouse');
  await page.goto('/rice-eats/');
  await expect(markers(page)).toHaveCount(WITH_LOCATION);
  await page
    .getByRole('list', { name: '餐厅列表' })
    .getByRole('link', { name: '点心大堂（虚构示例）' })
    .hover();
  await expect(page.locator('.leaflet-marker-icon.is-hovered')).toHaveAttribute(
    'title',
    '点心大堂（虚构示例）',
  );
  await page.mouse.move(5, 5);
  await expect(page.locator('.leaflet-marker-icon.is-hovered')).toHaveCount(0);
});

for (const [name, size] of [
  ['small', { width: 320, height: 568 }],
  ['large', { width: 430, height: 932 }],
] as const) {
  test(`mobile (${name}): details open in the sheet, which scrolls like the list`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile layout');
    await page.setViewportSize(size);
    await page.goto('/rice-eats/');
    await expect(markers(page)).toHaveCount(WITH_LOCATION);
    const sheet = page.getByRole('region', { name: '餐厅列表面板' });
    const handle = () => sheet.getByRole('button', { name: /^列表/ });
    // Collapse the sheet, then open a restaurant from the map: the sheet makes room.
    const bar = (await handle().boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + 4);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width / 2, size.height - 4, { steps: 6 });
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-state', 'collapsed');
    const marker = page.locator('.leaflet-marker-icon[title="点心大堂（虚构示例）"]');
    await marker.focus();
    await marker.press('Enter');
    await expect(sheet.getByRole('heading', { level: 1 })).toHaveText('点心大堂（虚构示例）');
    await expect(sheet).toHaveAttribute('data-state', 'half');
    // Expanded, the details cover the map and scroll inside the sheet.
    await handle().click();
    await expect(sheet).toHaveAttribute('data-state', 'expanded');
    const scroller = sheet
      .getByRole('heading', { level: 1 })
      .locator('xpath=ancestor::div[contains(@class, "overflow-y-auto")][1]');
    await scroller.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(sheet).toHaveAttribute('data-state', 'expanded');
    await sheet.getByRole('button', { name: '← 返回列表' }).click();
    expect(await listNames(page)).toHaveLength(PUBLISHED);
  });
}

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

  // Drag the handle up: expanded.
  const handle = (await sheet.getByRole('button', { name: /列表半展开/ }).boundingBox())!;
  const drag = async (x: number, y: number, dy: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 8 });
    await page.mouse.up();
  };
  await drag(handle.x + handle.width / 2, handle.y + 4, -250);
  await expect(sheet).toHaveAttribute('data-state', 'expanded');
  // Scrolling the list inside does not move the sheet.
  await sheet.getByRole('list', { name: '餐厅列表' }).hover();
  await page.mouse.wheel(0, 300);
  await expect(sheet).toHaveAttribute('data-state', 'expanded');

  // Dragging down from the bar's empty space (beside the filter buttons)
  // collapses it; the filters and list survive every state.
  const bar = (await sheet.getByRole('group', { name: '筛选' }).boundingBox())!;
  const bottom = page.viewportSize()!.height - 4;
  await drag(bar.x + bar.width - 8, bar.y + bar.height / 2, bottom - (bar.y + bar.height / 2));
  await expect(sheet).toHaveAttribute('data-state', 'collapsed');
  // Leaflet still fills its container and the pins stay usable.
  expect((await map.boundingBox())!.height).toBeGreaterThan(400);
  const collapsed = (await sheet.getByRole('button', { name: /列表已收起/ }).boundingBox())!;
  await drag(collapsed.x + collapsed.width / 2, collapsed.y + 4, -200);
  await expect(sheet).toHaveAttribute('data-state', 'half');
  // No extra buttons beside the handle.
  await expect(sheet.getByRole('button', { name: '看地图' })).toHaveCount(0);
  // Tapping the handle (a button for keyboards too) also changes the state.
  await sheet.getByRole('button', { name: /列表半展开/ }).click();
  await expect(sheet).toHaveAttribute('data-state', 'expanded');
  await sheet.getByRole('button', { name: /列表已展开/ }).click();
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

  // Every image of the details loads from the /rice-eats/ base path.
  const images = page.locator('article img');
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

  // The details sit beside the map, which selects the restaurant.
  await expect(page.locator('.leaflet-marker-icon.is-selected')).toHaveAttribute(
    'title',
    '点心大堂（虚构示例）',
  );
  await page.getByRole('button', { name: '← 返回列表' }).click();
  await expect(page).toHaveURL(/\/rice-eats\/\?id=fixture-dim-sum-hall$/);
});

test('a dish shows all of its photos, and a tag added to the registry filters like any other', async ({
  page,
}) => {
  await page.goto('/rice-eats/r/fixture-bayou-bbq/');
  const photos = page.getByRole('group', { name: '烟熏牛胸（示例）的照片，共 3 张' });
  await expect(photos.getByRole('button')).toHaveCount(3);
  const main = page.getByRole('img', { name: '烟熏牛胸（示例）（1/3）' });
  await expect(main).toBeVisible();
  await photos.getByRole('button', { name: '查看第 3 张照片' }).click();
  await expect(page.getByRole('img', { name: '烟熏牛胸（示例）（3/3）' })).toBeVisible();
  await expect(photos.getByRole('button', { name: '查看第 3 张照片' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(photos.getByRole('button', { name: '查看第 1 张照片' })).toBeFocused();
  await expect(main).toBeVisible();
  // A tag that exists only in the registry (content/tags.json), with its label.
  await expect(
    page.getByRole('list', { name: '标签' }).getByText('可带宠物（示例）'),
  ).toBeVisible();

  await page.goto('/rice-eats/');
  await filter(page, /^标签/, '可带宠物（示例）');
  await expect(page).toHaveURL(/\?tag=pet-friendly$/);
  expect(await listNames(page)).toEqual(['河湾烤肉（虚构示例）']);
  await page.reload();
  expect(await listNames(page)).toEqual(['河湾烤肉（虚构示例）']);
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
  await expect(page.locator('[aria-current="step"]')).toContainText('选择餐厅');
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
  await expect(page.locator('[aria-current="step"]')).toContainText('填写点评');
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
  await page.getByRole('button', { name: /^列表查看地图范围内的 \d+ 家餐厅/ }).click();
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
  await area.getByRole('button', { name: '或者：输入地址或地点' }).click();
  await area.getByRole('searchbox', { name: '输入地址或地点' }).fill('2111 Norfolk');
  await area.getByRole('searchbox', { name: '输入地址或地点' }).press('Enter');
  await expect(area.getByText('当前查找区域：2111 Norfolk St')).toBeVisible();
  await expect(page.getByRole('region', { name: '已选餐厅' })).toHaveCount(0);
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
  await area.getByRole('button', { name: '或者：输入地址或地点' }).click();
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
  await area.getByRole('button', { name: '或者：输入地址或地点' }).click();
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

  // The name search (a fallback) narrows the restaurants in view.
  await page.getByRole('button', { name: '或者：在当前区域搜索餐厅' }).click();
  await page.getByRole('searchbox', { name: '在当前区域搜索餐厅' }).fill('noodle');
  const result = page
    .getByRole('list', { name: '地图上的餐厅' })
    .getByRole('button', { name: /Fake Noodle Bar/ });
  await result.click();
  await expect(page.getByRole('region', { name: '已选餐厅' })).toContainText('Fake Noodle Bar');
  await expect(pin(page, 'Fake Noodle Bar')).toHaveClass(/is-selected/);
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

test('the manual pin keeps its name inside the map, wherever it is', async ({ page }) => {
  await page.route(/^https:\/\/api\.geoapify\.com\//, (route) =>
    route.fulfill({ json: { features: [] } }),
  );
  await page.goto('/rice-eats/submit/');
  await page.getByRole('button', { name: '手动添加餐厅' }).click();
  const name = page.getByLabel('餐厅名称');
  await name.fill('面馆');
  const map = page.getByRole('region', { name: '标出餐厅位置的地图' });
  await map.scrollIntoViewIfNeeded();
  let box = (await map.boundingBox())!;
  const label = page.locator('.leaflet-marker-icon[title="餐厅位置"] .poi-label');
  const pinTip = page.locator('.leaflet-marker-icon[title="餐厅位置"]');
  /** The rendered label lies inside the map; returns its side. */
  const inside = async () => {
    const l = (await label.boundingBox())!;
    expect(l.x).toBeGreaterThanOrEqual(box.x - 0.5);
    expect(l.x + l.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    expect(l.y).toBeGreaterThanOrEqual(box.y - 0.5);
    const pin = (await pinTip.boundingBox())!;
    return l.x >= pin.x + pin.width / 2 ? 'right' : 'left';
  };
  const place = async (x: number, y = box.height / 2) => {
    await map.click({ position: { x, y } });
    await page.waitForTimeout(300);
  };

  // In the middle: whole name on the right.
  await place(box.width / 2);
  await expect(label).toHaveText('面馆');
  expect(await inside()).toBe('right');
  // Near the right edge: on the left.
  await place(box.width - 24);
  expect(await inside()).toBe('left');
  // Near the left edge (clear of the zoom buttons): on the right.
  await place(24, box.height - 60);
  expect(await inside()).toBe('right');

  // A long name follows (truncated when needed) and stays inside, on phones too.
  await place(box.width - 24);
  await name.fill('一家名字非常非常长的手工拉面和川味小吃餐厅（莱斯大学附近分店）');
  await expect(label).toHaveText(/^一家名字非常/);
  // Typing may scroll the name field into view: measure the map again.
  await map.scrollIntoViewIfNeeded();
  box = (await map.boundingBox())!;
  expect(await inside()).toBe('left');

  // Moving the map lays the name out again: dragged to the left edge, it flips.
  const pin = (await pinTip.boundingBox())!;
  const tipX = pin.x + pin.width / 2;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - (tipX - box.x - 24), box.y + 40, { steps: 6 });
  // Hold still before letting go, so the map does not glide on (inertia).
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect(await inside()).toBe('right');
  // Zooming in moves the pin away from the center; the name is laid out again
  // and stays inside.
  await place(box.width * 0.4);
  expect(await inside()).toBe('right');
  await map.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(600);
  await inside();
});

test('the manual pin tip marks exactly the clicked point, through zooms, pans, and resizes', async ({
  page,
}) => {
  await page.route(/^https:\/\/api\.geoapify\.com\//, (route) =>
    route.fulfill({ json: { features: [] } }),
  );
  await page.goto('/rice-eats/submit/');
  await page.getByRole('button', { name: '手动添加餐厅' }).click();
  await page.getByLabel('餐厅名称').fill('面馆');
  const map = page.getByRole('region', { name: '标出餐厅位置的地图' });
  await map.scrollIntoViewIfNeeded();
  const marker = page.locator('.leaflet-marker-icon[title="餐厅位置"]');
  /** The tip of the drawn pin (bottom center of the visible shape), in page pixels. */
  const tip = async () => {
    const shape = (await marker.locator('.pin-shape').boundingBox())!;
    return { x: shape.x + shape.width / 2, y: shape.y + shape.height };
  };
  /** The map's inner area (Leaflet's container points start inside the border). */
  const inner = () =>
    map.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x + el.clientLeft,
        y: r.y + el.clientTop,
        width: el.clientWidth,
        height: el.clientHeight,
      };
    });
  const expectAt = async (x: number, y: number) => {
    const t = await tip();
    // Leaflet rounds marker positions to whole pixels.
    expect(Math.abs(t.x - x)).toBeLessThanOrEqual(1);
    expect(Math.abs(t.y - y)).toBeLessThanOrEqual(1);
  };

  // Repeated clicks anywhere in the map: the tip lands on each one.
  const box = await inner();
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.2, 0.8],
    [0.85, 0.25],
    [0.6, 0.9],
  ] as const) {
    const x = box.x + box.width * fx;
    const y = box.y + box.height * fy;
    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    await expectAt(x, y);
  }

  // At the map center the stored location is the map center: Rice, where the map opened.
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(150);
  await expectAt(center.x, center.y);

  // Zooming keeps the center, so the tip stays on it at every zoom level.
  for (const control of ['Zoom in', 'Zoom in', 'Zoom out', 'Zoom out', 'Zoom out']) {
    await map.getByRole('button', { name: control }).click();
    await page.waitForTimeout(400);
    await expectAt(center.x, center.y);
  }
  await map.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(400);

  // Panning moves the tip with the map, pixel for pixel.
  const before = await tip();
  await page.mouse.move(center.x + 40, center.y + 30);
  await page.mouse.down();
  await page.mouse.move(center.x - 20, center.y - 10, { steps: 6 });
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expectAt(before.x - 60, before.y - 40);

  // A resized window keeps the map's center, and the pin stays on its place
  // relative to it.
  const fromCenter = async () => {
    const [t, b] = [await tip(), await inner()];
    return { x: t.x - (b.x + b.width / 2), y: t.y - (b.y + b.height / 2) };
  };
  const offset = await fromCenter();
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width - 37, height: size.height - 23 });
  await page.waitForTimeout(500);
  const resized = await fromCenter();
  expect(Math.abs(resized.x - offset.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(resized.y - offset.y)).toBeLessThanOrEqual(1);
  await page.setViewportSize(size);

  // The location reaches the form: a fresh manual entry opens where the
  // selection map is (Rice), and a click at its center stores Rice's center.
  await page.getByRole('button', { name: '返回搜索' }).click();
  await page.getByRole('button', { name: '手动添加餐厅' }).click();
  await page.getByLabel('餐厅名称').fill('面馆');
  await map.scrollIntoViewIfNeeded();
  const start = await inner();
  await page.mouse.click(start.x + start.width / 2, start.y + start.height / 2);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: NEXT }).click();
  const query = new URLSearchParams((await formQuery(page).textContent()) ?? '');
  expect(Math.abs(Number(query.get('restaurant_lat')) - 29.7174)).toBeLessThan(0.00003);
  expect(Math.abs(Number(query.get('restaurant_lng')) - -95.4018)).toBeLessThan(0.00003);
});

test('pin names stay inside the map at the top, bottom, and corners', async ({ page }) => {
  await fakePlaces(page);
  await page.goto('/rice-eats/submit/');
  const pickMap = page.getByRole('region', { name: '附近餐厅地图' });
  await expect(pin(page, 'Fake Noodle Bar')).toBeVisible();
  await pickMap.scrollIntoViewIfNeeded();
  /** Every rendered label of the given marker lies inside the map's box. */
  const insideMap = async (map: typeof pickMap, marker: ReturnType<typeof pin>) => {
    const box = (await map.boundingBox())!;
    const label = (await marker.locator('.poi-label').boundingBox())!;
    expect(label.x).toBeGreaterThanOrEqual(box.x - 0.5);
    expect(label.y).toBeGreaterThanOrEqual(box.y - 0.5);
    expect(label.x + label.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    expect(label.y + label.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
  };
  /** Pans the map (slowly, without inertia) so the marker's tip lands at (x, y) in the map. */
  const panTo = async (
    map: typeof pickMap,
    marker: ReturnType<typeof pin>,
    x: number,
    y: number,
  ) => {
    const box = (await map.boundingBox())!;
    const p = (await marker.boundingBox())!;
    const tip = { x: p.x + p.width / 2, y: p.y + p.height };
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + (box.x + x - tip.x), from.y + (box.y + y - tip.y), { steps: 8 });
    await page.waitForTimeout(400);
    await page.mouse.up();
    await page.waitForTimeout(500);
  };

  // A selected restaurant at the top edge, then at the top-right corner.
  const selected = pin(page, 'Fake Noodle Bar');
  await selected.click();
  await expect(selected).toHaveClass(/is-selected/);
  let box = (await pickMap.boundingBox())!;
  await panTo(pickMap, selected, box.width / 2, 14);
  await insideMap(pickMap, selected);
  await panTo(pickMap, selected, box.width - 14, 14);
  await insideMap(pickMap, selected);

  // The manual pin: top, top right, bottom left (clear of the zoom buttons).
  await page.getByRole('button', { name: '手动添加餐厅' }).click();
  await page.getByLabel('餐厅名称').fill('一家名字很长的手工面馆（莱斯大学店）');
  const manualMap = page.getByRole('region', { name: '标出餐厅位置的地图' });
  await manualMap.scrollIntoViewIfNeeded();
  box = (await manualMap.boundingBox())!;
  const manual = page.locator('.leaflet-marker-icon[title="餐厅位置"]');
  for (const [x, y] of [
    [box.width / 2, 6],
    [box.width - 8, 6],
    [box.width - 8, box.height - 30],
    [8, box.height - 30],
  ] as const) {
    await manualMap.click({ position: { x, y } });
    await page.waitForTimeout(300);
    await insideMap(manualMap, manual);
  }
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
  // The form comes right away: keywords are one of its questions, not a step of their own.
  await expect(page.getByText(/关键词/)).toHaveCount(0);
  const query = formQuery(page);
  await expect(
    page.frameLocator('iframe[title="Rice Eats 投稿表单"]').getByText('Stub Tally form'),
  ).toBeVisible();
  await expect(query).toContainText('restaurant_id=fixture-sichuan-house');
  await expect(query).toContainText('restaurant_lat=29.705300&restaurant_lng=-95.546500');
  await expect(query).toContainText('selection_method=existing&source=restaurant-page');
  await expect(page.locator('[aria-current="step"]')).toContainText('填写点评');
  // Tally reports the form loaded: no loading note and no fallback link.
  await expect(page.getByText('正在加载投稿表单…')).toHaveCount(0);
  await expect(page.getByText(/在新窗口打开投稿表单/)).toHaveCount(0);

  await page.getByRole('button', { name: '更换餐厅' }).click();
  await expect(page.locator('[aria-current="step"]')).toContainText('选择餐厅');
  await expect(page.getByRole('region', { name: '已选餐厅' })).toContainText('蜀味小馆');
  await page.getByRole('link', { name: '我要投稿', exact: true }).click();
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
  const entry = page.getByRole('link', { name: '我要投稿', exact: true });
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
