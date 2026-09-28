import { describe, expect, it } from 'vitest';
import { createSafeLookup, isPublicAddress, SsrfError, validateUrl } from '../src/security/ssrf.js';

const strict = { allowPrivateNetworks: false, allowedPorts: [80, 443] };

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1', '::1', '::', 'fc00::1', 'fe80::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1', '64:ff9b::a00:1', '2002:a00:1::1',
  ])('rejects %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('accepts %s', (ip) =>
    expect(isPublicAddress(ip)).toBe(true),
  );
});

describe('validateUrl', () => {
  it('accepts a normal https URL', () => {
    expect(validateUrl('https://example.com/jobs?x=1', strict).hostname).toBe('example.com');
  });

  it.each([
    ['file:///etc/passwd', /scheme/],
    ['ftp://example.com/', /scheme/],
    ['gopher://example.com/', /scheme/],
    ['https://user:pass@example.com/', /credentials/],
    ['http://example.com:22/', /port/],
    ['http://localhost/', /not allowed/],
    ['http://foo.localhost/', /not allowed/],
    ['http://printer.local/', /not allowed/],
    ['http://metadata.google.internal/', /not allowed/],
    ['http://intranet/', /single-label/],
    ['http://127.0.0.1/', /non-public/],
    ['http://[::1]/', /non-public/],
    ['http://169.254.169.254/latest/meta-data', /non-public/],
    ['http://2130706433/', /non-public|numeric/],
    ['http://0x7f.1/', /non-public|numeric/],
    ['not a url', /invalid/],
  ])('rejects %s', (url, msg) => {
    expect(() => validateUrl(url, strict)).toThrow(SsrfError);
    expect(() => validateUrl(url, strict)).toThrow(msg);
  });

  it('allows loopback only when private networks are explicitly allowed', () => {
    expect(() => validateUrl('http://127.0.0.1:8080/', { allowPrivateNetworks: true, allowedPorts: [] })).not.toThrow();
  });
});

describe('createSafeLookup', () => {
  const lookup = (host: string) =>
    new Promise<unknown>((resolve, reject) =>
      createSafeLookup(strict)(host, {}, (err, address) => (err ? reject(err) : resolve(address))),
    );

  it('refuses hostnames that resolve to loopback (DNS rebinding defence)', async () => {
    await expect(lookup('localhost')).rejects.toThrow(/non-public/);
  });

  it('refuses a literal private address handed to the resolver', async () => {
    await expect(lookup('10.0.0.1')).rejects.toThrow(/non-public/);
  });
});
