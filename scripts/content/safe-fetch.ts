// Downloads of untrusted links (Tally photo URLs from public submissions).
// Every request, including each redirect, goes only to an allowlisted https
// host whose DNS answers are public addresses; responses are size-limited and
// time-limited. Errors never contain query strings (signed-URL tokens).

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Hosts Tally uses to serve uploaded files. Exact names, no wildcards: if
 * Tally moves its files elsewhere, downloads fail closed and the photo can be
 * added by hand (docs/submissions.md) until this list is reviewed.
 */
export const TRUSTED_PHOTO_HOSTS = ['tally.so', 'storage.tally.so'];
export const MAX_REDIRECTS = 3;
export const DOWNLOAD_TIMEOUT_MS = 30_000;

export class DownloadError extends Error {}

/** Removes credentials, query strings, and fragments before a link is shown. */
export function redactUrl(url: string | URL): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '(invalid link)';
  }
}

/** Why a URL may not be requested, or undefined when it may. */
export function urlProblem(url: URL, hosts: readonly string[] = TRUSTED_PHOTO_HOSTS): string | undefined {
  if (url.protocol !== 'https:') return 'not an https link';
  if (url.username || url.password) return 'link contains credentials';
  if (url.port && url.port !== '443') return 'link uses a non-standard port';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, ''))) return 'link points to an IP address';
  if (!hosts.includes(host)) return `host ${host} is not a trusted Tally file host`;
  return undefined;
}

/** True for addresses a download must never reach (loopback, private, link-local, metadata, ...). */
export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata (169.254.169.254)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
    if (mapped) return isForbiddenAddress(mapped);
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) || // unique local
      /^fe[89ab]/.test(lower) || // link-local
      lower.startsWith('ff') || // multicast
      lower.startsWith('fd00:ec2') // AWS metadata over IPv6
    );
  }
  return true;
}

export type Lookup = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface SafeFetchOptions {
  maxBytes: number;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  hosts?: readonly string[];
  timeoutMs?: number;
}

/**
 * GETs `url` and returns its body. Redirects are followed by hand (at most
 * MAX_REDIRECTS, no loops), each target checked before it is requested. The
 * body is read with a hard byte limit, whatever Content-Length says.
 */
export async function safeDownload(url: string, options: SafeFetchOptions): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? defaultLookup;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new DownloadError('malformed link');
  }
  const visited = new Set<string>();
  for (let hop = 0; ; hop++) {
    const problem = urlProblem(current, options.hosts);
    if (problem) throw new DownloadError(`${problem} (${redactUrl(current)})`);
    if (visited.has(current.href)) throw new DownloadError(`redirect loop at ${redactUrl(current)}`);
    visited.add(current.href);
    await checkDns(current.hostname, lookup);

    let response: Response;
    try {
      response = await fetchImpl(current.href, { redirect: 'manual', signal });
    } catch (e) {
      const reason = (e as Error).name === 'TimeoutError' ? 'timed out' : 'network error';
      throw new DownloadError(`${reason} (${redactUrl(current)})`);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new DownloadError(`more than ${MAX_REDIRECTS} redirects`);
      const location = response.headers.get('location');
      if (!location) throw new DownloadError(`redirect without a destination (${redactUrl(current)})`);
      try {
        current = new URL(location, current);
      } catch {
        throw new DownloadError(`malformed redirect from ${redactUrl(current)}`);
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadError(
        `HTTP ${response.status} (${redactUrl(current)}; the link may have expired or need the Tally login)`,
      );
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > options.maxBytes) {
      await response.body?.cancel();
      throw new DownloadError(`larger than ${options.maxBytes / 1024 / 1024} MB`);
    }
    return readLimited(response, options.maxBytes);
  }
}

async function checkDns(host: string, lookup: Lookup) {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new DownloadError(`cannot resolve ${host}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isForbiddenAddress(a.address))) {
    throw new DownloadError(`${host} resolves to a private or reserved address`);
  }
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new DownloadError(`larger than ${limit / 1024 / 1024} MB`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
