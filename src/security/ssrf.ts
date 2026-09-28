/**
 * SSRF protection.
 *
 * Two layers:
 *  1. `validateUrl` rejects bad schemes, credentials, ports, internal-looking
 *     hostnames and literal non-public IPs before any request is made.
 *  2. `createSafeLookup` is installed as the socket's DNS lookup, so every
 *     address the connection actually uses is checked at connect time. That
 *     closes the DNS-rebinding gap between "validate" and "connect", and it
 *     applies to every redirect hop.
 */
import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

export class SsrfError extends Error {
  readonly code = 'SSRF_BLOCKED';
}

export interface SsrfPolicy {
  allowPrivateNetworks: boolean;
  /** Empty means any port. */
  allowedPorts: number[];
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let addr = ipaddr.parse(address);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    // ::ffff:10.0.0.1 and friends must be judged as the IPv4 address they embed.
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
    else {
      const range = v6.range();
      // 6to4 / Teredo / NAT64 can smuggle internal IPv4 targets; refuse them outright.
      if (range !== 'unicast') return false;
      // ipaddr.js labels most of 2000::/3 "unicast"; also refuse documentation space.
      if (v6.match(ipaddr.IPv6.parse('2001:db8::'), 32)) return false;
      return true;
    }
  }
  const v4 = addr as ipaddr.IPv4;
  // "unicast" excludes private, loopback, link-local (incl. 169.254.169.254 metadata),
  // CGNAT, multicast, broadcast, reserved, 0.0.0.0/8, benchmarking and documentation ranges.
  return v4.range() === 'unicast';
}

function checkAddress(address: string, policy: SsrfPolicy): void {
  if (policy.allowPrivateNetworks) return;
  if (!isPublicAddress(address)) throw new SsrfError(`refusing to connect to non-public address ${address}`);
}

/** Static checks on a URL. Throws SsrfError; returns the parsed URL. */
export function validateUrl(input: string | URL, policy: SsrfPolicy): URL {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`unsupported scheme ${url.protocol} (only http and https)`);
  }
  if (url.username || url.password) throw new SsrfError('URLs with embedded credentials are not allowed');
  if (input.toString().length > 2048) throw new SsrfError('URL too long');

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (policy.allowedPorts.length > 0 && !policy.allowedPorts.includes(port)) {
    throw new SsrfError(`port ${port} is not allowed`);
  }

  // URL keeps IPv6 literals bracketed.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) throw new SsrfError('missing host');

  if (net.isIP(host)) {
    checkAddress(host, policy);
    return url;
  }
  if (!policy.allowPrivateNetworks) {
    if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
      throw new SsrfError(`host ${host} is not allowed`);
    }
    if (!host.includes('.')) throw new SsrfError(`single-label host ${host} is not allowed`);
    // Hosts like "0x7f.1" or "2130706433" that legacy resolvers treat as IPs.
    if (/^[0-9.x]+$/i.test(host)) throw new SsrfError(`numeric host ${host} is not allowed`);
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A drop-in for dns.lookup that refuses to hand back non-public addresses.
 * Any disallowed address in the answer fails the whole lookup: we'd rather
 * miss a page than let a mixed answer route us inward.
 */
export function createSafeLookup(policy: SsrfPolicy) {
  return function safeLookup(hostname: string, options: dns.LookupOptions | LookupCallback, callback?: LookupCallback) {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const opts: dns.LookupOptions = typeof options === 'function' ? {} : options ?? {};
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err, '');
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0) return cb(Object.assign(new Error(`no addresses for ${hostname}`), { code: 'ENOTFOUND' }), '');
      try {
        for (const a of list) checkAddress(a.address, policy);
      } catch (e) {
        return cb(e as NodeJS.ErrnoException, '');
      }
      if (opts.all) return cb(null, list);
      const first = list[0]!;
      cb(null, first.address, first.family);
    });
  };
}
