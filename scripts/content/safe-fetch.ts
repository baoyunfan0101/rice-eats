// Downloads of untrusted links: Tally photo URLs from public submissions, and
// (for restaurant information) place-details APIs and public web pages.
// Every request, including each redirect, goes only to an https host whose
// DNS answers are public addresses (and, unless a caller allows any public
// host, to an allowlisted one); responses are size-limited and time-limited.
// Errors never contain query strings (signed-URL tokens, API keys).

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

/**
 * Hosts allowed for a request: an exact list, or ANY_PUBLIC_HOST for pages
 * named by a person (a restaurant's website), where the address checks below
 * are the only limit.
 */
export const ANY_PUBLIC_HOST = 'any-public-host';
export type HostPolicy = readonly string[] | typeof ANY_PUBLIC_HOST;

/** Why a URL may not be requested, or undefined when it may. */
export function urlProblem(url: URL, hosts: HostPolicy = TRUSTED_PHOTO_HOSTS): string | undefined {
  if (url.protocol !== 'https:') return 'not an https link';
  if (url.username || url.password) return 'link contains credentials';
  if (url.port && url.port !== '443') return 'link uses a non-standard port';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, ''))) return 'link points to an IP address';
  if (hosts === ANY_PUBLIC_HOST) {
    return host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')
      ? `host ${host} is not public`
      : undefined;
  }
  if (!hosts.includes(host)) {
    return hosts === TRUSTED_PHOTO_HOSTS
      ? `host ${host} is not a trusted Tally file host`
      : `host ${host} is not an allowed host`;
  }
  return undefined;
}

// Address policy: only globally routable unicast addresses are allowed.
// Addresses are parsed into integers and compared with CIDR ranges, so every
// textual form of an address (e.g. "::ffff:127.0.0.1" and "::ffff:7f00:1")
// is classified the same way. Ranges follow the IANA IPv4 and IPv6
// special-purpose address registries.

const IPV4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

/** Only global unicast (2000::/3) is allowed, minus these special-purpose ranges. */
const IPV6_GLOBAL_UNICAST: [string, number] = ['2000::', 3];
const IPV6_BLOCKED: [string, number][] = [
  ['2001::', 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID, ...)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
];
/** IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) addresses embed an IPv4 address. */
const IPV6_EMBEDDING_IPV4: [string, number][] = [
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
];

function parseIpv4(address: string): bigint | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
}

function parseIpv6(address: string): bigint | undefined {
  if (isIP(address) !== 6 || address.includes('%')) return undefined; // no zone ids
  let text = address.toLowerCase();
  // A trailing dotted IPv4 part ("::ffff:127.0.0.1") becomes two hex groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const v4 = parseIpv4(dotted)!;
    text = `${text.slice(0, -dotted.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const missing = 8 - groups(head).length - groups(tail).length;
  const all = tail === undefined ? groups(head) : [...groups(head), ...Array(missing).fill('0'), ...groups(tail)];
  return all.reduce((n, group) => (n << 16n) | BigInt(parseInt(group, 16)), 0n);
}

const inRange = (value: bigint, bits: number, [base, prefix]: [string, number], parse: (a: string) => bigint | undefined) =>
  value >> BigInt(bits - prefix) === parse(base)! >> BigInt(bits - prefix);

/**
 * True for addresses a download must never reach: anything that is not a
 * globally routable unicast address (loopback, private, link-local, metadata,
 * documentation, multicast, reserved, ...), and anything that is not a valid
 * IP address. IPv4-mapped and NAT64 IPv6 addresses are judged by the IPv4
 * address they contain.
 */
export function isForbiddenAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== undefined) return IPV4_BLOCKED.some((range) => inRange(v4, 32, range, parseIpv4));
  const v6 = parseIpv6(address);
  if (v6 === undefined) return true;
  if (IPV6_EMBEDDING_IPV4.some((range) => inRange(v6, 128, range, parseIpv6))) {
    const embedded = v6 & 0xffffffffn;
    return IPV4_BLOCKED.some((range) => inRange(embedded, 32, range, parseIpv4));
  }
  if (!inRange(v6, 128, IPV6_GLOBAL_UNICAST, parseIpv6)) return true;
  return IPV6_BLOCKED.some((range) => inRange(v6, 128, range, parseIpv6));
}

export type Lookup = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface SafeFetchOptions {
  maxBytes: number;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  hosts?: HostPolicy;
  timeoutMs?: number;
  /** Request headers (e.g. Accept); never credentials from a submission. */
  headers?: Record<string, string>;
}

/**
 * GETs `url` and returns its body. Redirects are followed by hand (at most
 * MAX_REDIRECTS, no loops), each target checked before it is requested. The
 * body is read with a hard byte limit, whatever Content-Length says.
 */
export async function safeDownload(url: string, options: SafeFetchOptions): Promise<Buffer> {
  return (await safeFetch(url, options)).body;
}

/** Like safeDownload, and also returns the final URL and the content type. */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions,
): Promise<{ body: Buffer; url: string; contentType: string }> {
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
      response = await fetchImpl(current.href, { redirect: 'manual', signal, headers: options.headers });
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
        `HTTP ${response.status} (${redactUrl(current)}` +
          `${(options.hosts ?? TRUSTED_PHOTO_HOSTS) === TRUSTED_PHOTO_HOSTS ? '; the link may have expired or need the Tally login' : ''})`,
      );
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > options.maxBytes) {
      await response.body?.cancel();
      throw new DownloadError(`larger than ${options.maxBytes / 1024 / 1024} MB`);
    }
    return {
      body: await readLimited(response, options.maxBytes),
      url: current.href,
      contentType: response.headers.get('content-type') ?? '',
    };
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
