import { describe, expect, it } from 'vitest';
import {
  DownloadError,
  isForbiddenAddress,
  MAX_REDIRECTS,
  redactUrl,
  safeDownload,
  urlProblem,
  type Lookup,
} from '../../scripts/content/safe-fetch.ts';

const MB = 1024 * 1024;
const START = 'https://storage.tally.so/private/a.jpg?accessToken=secret-token';
// Globally routable example addresses (mocked DNS; no request leaves the process).
const PUBLIC_V4 = '8.8.8.8';
const PUBLIC_V6 = '2606:4700:4700::1111';
const publicDns: Lookup = async () => [{ address: PUBLIC_V4 }, { address: PUBLIC_V6 }];

/** A fake server: each path maps to a response factory; requests are recorded. */
function server(routes: Record<string, () => Response>) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe('manual');
    const url = new URL(String(input));
    requests.push(`${url.host}${url.pathname}`);
    const route = routes[`${url.host}${url.pathname}`];
    return route ? route() : new Response('', { status: 404 });
  }) as typeof fetch;
  return { requests, fetchImpl };
}
const redirect =
  (location: string, status = 302) =>
  () =>
    new Response(null, { status, headers: { location } });
const body =
  (bytes: Uint8Array<ArrayBuffer> | string, headers: Record<string, string> = {}) =>
  () =>
    new Response(bytes, { headers });

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(DownloadError);
    const message = (e as Error).message;
    expect(message).not.toContain('secret');
    return message;
  }
  throw new Error('expected the download to fail');
}

describe('safe downloads', () => {
  it('downloads a direct Tally link', async () => {
    const { fetchImpl, requests } = server({ 'storage.tally.so/private/a.jpg': body('ok') });
    const bytes = await safeDownload(START, { maxBytes: MB, fetchImpl, lookup: publicDns });
    expect(bytes.toString()).toBe('ok');
    expect(requests).toEqual(['storage.tally.so/private/a.jpg']);
  });

  it('follows a redirect to a trusted Tally host, checking it first', async () => {
    const { fetchImpl, requests } = server({
      'tally.so/file': redirect('https://storage.tally.so/private/a.jpg?sig=secret'),
      'storage.tally.so/private/a.jpg': body('ok'),
    });
    const bytes = await safeDownload('https://tally.so/file?accessToken=secret', {
      maxBytes: MB,
      fetchImpl,
      lookup: publicDns,
    });
    expect(bytes.toString()).toBe('ok');
    expect(requests).toEqual(['tally.so/file', 'storage.tally.so/private/a.jpg']);
  });

  it.each([
    ['an arbitrary external domain', 'https://evil.example/a.jpg', /not a trusted Tally file host/],
    ['a look-alike domain', 'https://storage.tally.so.evil.example/a.jpg', /not a trusted/],
    ['localhost', 'https://localhost/a.jpg', /not a trusted/],
    ['a loopback IP', 'https://127.0.0.1/a.jpg', /IP address/],
    ['a link-local metadata IP', 'https://169.254.169.254/latest/meta-data', /IP address/],
    ['an IPv6 loopback', 'https://[::1]/a.jpg', /IP address/],
    ['plain http', 'http://storage.tally.so/private/a.jpg', /not an https link/],
    ['embedded credentials', 'https://user:pw@storage.tally.so/a.jpg', /credentials/],
    ['a non-standard port', 'https://storage.tally.so:8443/a.jpg', /port/],
  ])('rejects a redirect to %s before requesting it', async (_, target, error) => {
    const { fetchImpl, requests } = server({
      'storage.tally.so/private/a.jpg': redirect(target),
    });
    expect(
      await failure(safeDownload(START, { maxBytes: MB, fetchImpl, lookup: publicDns })),
    ).toMatch(error);
    expect(requests).toEqual(['storage.tally.so/private/a.jpg']);
  });

  it('rejects untrusted initial links without any request', async () => {
    const { fetchImpl, requests } = server({});
    for (const url of ['https://evil.example/a.jpg', 'not a url', 'file:///etc/passwd']) {
      await failure(safeDownload(url, { maxBytes: MB, fetchImpl, lookup: publicDns }));
    }
    expect(requests).toEqual([]);
  });

  it('rejects trusted names that resolve to private or reserved addresses', async () => {
    const { fetchImpl, requests } = server({ 'storage.tally.so/private/a.jpg': body('ok') });
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.5',
      '169.254.169.254',
      '203.0.113.10',
      '::1',
      'fd12::1',
      'fe80::1',
      '::ffff:a00:1', // 10.0.0.1, IPv4-mapped in hex
      '::ffff:7f00:1', // 127.0.0.1
    ]) {
      // A forbidden answer among public ones still blocks the request.
      const lookup: Lookup = async () => [
        { address: PUBLIC_V4 },
        { address: PUBLIC_V6 },
        { address },
      ];
      expect(await failure(safeDownload(START, { maxBytes: MB, fetchImpl, lookup }))).toMatch(
        /private or reserved address/,
      );
    }
    expect(requests).toEqual([]);
    for (const lookup of [
      async () => [],
      async () => Promise.reject(new Error('ENOTFOUND')),
    ] as Lookup[]) {
      await failure(safeDownload(START, { maxBytes: MB, fetchImpl, lookup }));
    }
    expect(requests).toEqual([]);
  });

  it('checks DNS for every redirect target before requesting it', async () => {
    const { fetchImpl, requests } = server({
      'storage.tally.so/private/a.jpg': redirect('https://tally.so/b'),
      'tally.so/b': body('ok'),
    });
    const lookup: Lookup = async (host) =>
      host === 'tally.so' ? [{ address: '::ffff:c0a8:101' }] : [{ address: PUBLIC_V4 }];
    expect(await failure(safeDownload(START, { maxBytes: MB, fetchImpl, lookup }))).toMatch(
      /tally\.so resolves to a private or reserved address/,
    );
    expect(requests).toEqual(['storage.tally.so/private/a.jpg']);
  });

  it('rejects malformed, missing, circular, and excessive redirects', async () => {
    const options = (routes: Record<string, () => Response>) => ({
      maxBytes: MB,
      lookup: publicDns,
      ...server(routes),
    });
    expect(
      await failure(
        safeDownload(
          START,
          options({ 'storage.tally.so/private/a.jpg': redirect('https://[bad') }),
        ),
      ),
    ).toMatch(/malformed redirect/);
    expect(
      await failure(
        safeDownload(
          START,
          options({ 'storage.tally.so/private/a.jpg': () => new Response(null, { status: 302 }) }),
        ),
      ),
    ).toMatch(/without a destination/);
    expect(
      await failure(
        safeDownload(
          START,
          options({
            'storage.tally.so/private/a.jpg': redirect('https://tally.so/b'),
            'tally.so/b': redirect(START),
          }),
        ),
      ),
    ).toMatch(/redirect loop/);
    const chain: Record<string, () => Response> = {
      'storage.tally.so/private/a.jpg': redirect('https://tally.so/r0'),
    };
    for (let i = 0; i < MAX_REDIRECTS + 1; i++)
      chain[`tally.so/r${i}`] = redirect(`https://tally.so/r${i + 1}`);
    expect(await failure(safeDownload(START, options(chain)))).toMatch(/more than 3 redirects/);
  });

  it('enforces the size limit after a redirect, with or without Content-Length', async () => {
    const big = new Uint8Array(MB + 1);
    const routes = (headers: Record<string, string>) => ({
      'storage.tally.so/private/a.jpg': redirect('https://tally.so/big'),
      'tally.so/big': body(big, headers),
    });
    for (const headers of [
      {} as Record<string, string>,
      { 'content-length': String(MB + 1) },
      { 'content-length': '10' },
    ]) {
      expect(
        await failure(
          safeDownload(START, { maxBytes: MB, lookup: publicDns, ...server(routes(headers)) }),
        ),
      ).toMatch(/larger than 1 MB/);
    }
  });

  it('gives up on slow servers', async () => {
    const hanging = ((_: string, init?: RequestInit) =>
      new Promise((_, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
      )) as typeof fetch;
    expect(
      await failure(
        safeDownload(START, { maxBytes: MB, fetchImpl: hanging, lookup: publicDns, timeoutMs: 20 }),
      ),
    ).toMatch(/timed out/);
  });

  it('reports HTTP errors and network failures without tokens', async () => {
    const { fetchImpl } = server({
      'storage.tally.so/private/a.jpg': () => new Response('', { status: 403 }),
    });
    const message = await failure(
      safeDownload(START, { maxBytes: MB, fetchImpl, lookup: publicDns }),
    );
    expect(message).toMatch(/HTTP 403 \(https:\/\/storage\.tally\.so\/private\/a\.jpg;/);
    const broken = (async () => {
      throw new Error(`connect failed for ${START}`);
    }) as typeof fetch;
    expect(
      await failure(safeDownload(START, { maxBytes: MB, fetchImpl: broken, lookup: publicDns })),
    ).toMatch(/network error/);
  });

  it('redacts credentials and query strings', () => {
    expect(redactUrl('https://u:p@storage.tally.so/x.jpg?accessToken=s#f')).toBe(
      'https://storage.tally.so/x.jpg',
    );
    expect(urlProblem(new URL('https://STORAGE.TALLY.SO./a'))).toBeUndefined();
  });

  describe('address classification', () => {
    // Each group lists equivalent forms of one IPv4 address: dotted, and
    // IPv4-mapped IPv6 in dotted, hexadecimal, and fully expanded notation.
    it.each([
      ['loopback', '127.0.0.1', true],
      ['private', '10.0.0.1', true],
      ['private', '192.168.1.1', true],
      ['link-local metadata', '169.254.169.254', true],
      ['documentation', '203.0.113.10', true],
      ['public', '8.8.8.8', false],
      ['public', '151.101.1.1', false],
    ])('classifies every form of %s %s the same way', (_, v4, forbidden) => {
      const [a, b, c, d] = v4.split('.').map(Number) as [number, number, number, number];
      const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
      for (const form of [
        v4,
        `::ffff:${v4}`,
        `::FFFF:${v4}`,
        `::ffff:${hex}`,
        `0:0:0:0:0:ffff:${hex}`,
        `0000:0000:0000:0000:0000:ffff:${hex}`,
      ]) {
        expect(isForbiddenAddress(form), form).toBe(forbidden);
      }
    });

    it.each([
      ['::ffff:7f00:1', 'IPv4-mapped loopback'],
      ['::ffff:a00:1', 'IPv4-mapped private'],
      ['::ffff:c0a8:101', 'IPv4-mapped private'],
      ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata'],
      ['64:ff9b::a00:1', 'NAT64 of a private address'],
      ['0.0.0.0', 'IPv4 "this network"'],
      ['100.64.0.1', 'carrier-grade NAT'],
      ['172.16.0.1', 'private'],
      ['192.0.2.1', 'documentation'],
      ['198.18.0.1', 'benchmarking'],
      ['198.51.100.1', 'documentation'],
      ['224.0.0.1', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'broadcast'],
      ['::1', 'IPv6 loopback'],
      ['::', 'unspecified'],
      ['::127.0.0.1', 'IPv4-compatible (deprecated)'],
      ['fc00::1', 'unique-local'],
      ['fd12:3456::1', 'unique-local'],
      ['fe80::1', 'link-local'],
      ['fe80::1%en0', 'link-local with zone'],
      ['fec0::1', 'site-local (deprecated)'],
      ['ff02::1', 'multicast'],
      ['2001:db8::1', 'documentation'],
      ['3fff::1', 'documentation'],
      ['2001::1', 'Teredo'],
      ['2001:2::1', 'benchmarking'],
      ['2002:a00:1::1', '6to4'],
      ['100::1', 'discard-only'],
      ['not an ip', 'invalid'],
      ['1.2.3', 'invalid'],
      ['::ffff:1:2:3', 'outside global unicast'],
      ['', 'empty'],
    ])('rejects %s (%s)', (address) => {
      expect(isForbiddenAddress(address)).toBe(true);
    });

    it.each([
      '8.8.8.8',
      '1.1.1.1',
      '::ffff:808:808',
      '64:ff9b::808:808',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '2a00:1450:4001::200e',
    ])('allows the globally routable address %s', (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    });
  });
});
