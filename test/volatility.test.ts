import { describe, expect, it } from 'vitest';
import { emptyStats, isVolatile, lineSignature, recordObservation, type LineStats } from '../src/extract/volatility.js';
import { clientBucket } from '../src/services/rateLimit.js';

describe('line signatures', () => {
  it('ignore numbers and calendar words but not meaning', () => {
    expect(lineSignature('1,204 views')).toBe(lineSignature('1,219 views'));
    expect(lineSignature('Updated Tue Sep 29 at 10:41')).toBe(lineSignature('Updated Wed Oct 1 at 09:02'));
    expect(lineSignature('Price: $10')).toBe(lineSignature('Price: $12'));
    expect(lineSignature('Price: $10')).not.toBe(lineSignature('Sold out'));
  });
});

describe('volatility learning', () => {
  const observe = (stats: LineStats, n: number, changed: string[]) => {
    let s = stats;
    for (let i = 0; i < n; i++) s = recordObservation(s, changed);
    return s;
  };

  it('learns that a counter changing on every check is noise', () => {
    let s = emptyStats();
    for (let i = 0; i < 6; i++) s = recordObservation(s, [`${1000 + i} views`, `${1001 + i} views`]);
    expect(isVolatile(s, '2000 views')).toBe(true);
  });

  it('needs enough evidence before suppressing anything', () => {
    const s = recordObservation(emptyStats(), ['42 views']);
    expect(isVolatile(s, '43 views')).toBe(false);
  });

  it('never suppresses a line that changes rarely (e.g. a weekly price change on hourly checks)', () => {
    let s = observe(emptyStats(), 100, []);
    s = recordObservation(s, ['Price: $10', 'Price: $12']);
    s = observe(s, 100, []);
    s = recordObservation(s, ['Price: $12', 'Price: $9']);
    expect(isVolatile(s, 'Price: $8')).toBe(false);
  });

  it('marks lines seen flipping between two back-to-back fetches as noise immediately', () => {
    const s = recordObservation(emptyStats(), [], ['Trending: Widget A']);
    expect(isVolatile(s, 'Trending: Widget A')).toBe(true);
  });

  it('forgets noise that stopped changing', () => {
    let s = recordObservation(emptyStats(), [], ['Now showing: 3 items']);
    s = observe(s, 20, []);
    expect(isVolatile(s, 'Now showing: 4 items')).toBe(false);
  });

  it('stays bounded', () => {
    let s = emptyStats();
    for (let i = 0; i < 700; i++) s = recordObservation(s, [`unique line ${'x'.repeat(i % 50)} ${String.fromCharCode(97 + (i % 26))}${i}`]);
    expect(s.observed).toBeLessThan(500);
    expect(Object.keys(s.sigs).length).toBeLessThanOrEqual(3000);
  });
});

describe('rate-limit buckets', () => {
  it('groups IPv6 clients by /64 and unwraps IPv4-mapped addresses', () => {
    expect(clientBucket('2001:db8:1:2:aaaa::1')).toBe(clientBucket('2001:db8:1:2:ffff::9'));
    expect(clientBucket('2001:db8:1:2::1')).not.toBe(clientBucket('2001:db8:1:3::1'));
    expect(clientBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientBucket('203.0.113.7')).toBe('203.0.113.7');
  });
});
