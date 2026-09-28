import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots } from '../src/fetch/robots.js';

describe('robots.txt', () => {
  const txt = `
# comment
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$

User-agent: WatchtowerBot
User-agent: OtherBot
Disallow: /no-watchtower
`;

  it('uses the most specific matching group for our agent', () => {
    const rules = parseRobots(txt);
    expect(isAllowed(rules, '/no-watchtower/x')).toBe(false);
    expect(isAllowed(rules, '/private')).toBe(true); // our group does not mention /private
  });

  it('falls back to * with longest-match precedence and wildcards', () => {
    const rules = parseRobots(txt, 'somebot');
    expect(isAllowed(rules, '/private/x')).toBe(false);
    expect(isAllowed(rules, '/private/public/page')).toBe(true);
    expect(isAllowed(rules, '/docs/a.pdf')).toBe(false);
    expect(isAllowed(rules, '/docs/a.pdf?x=1')).toBe(true);
    expect(isAllowed(rules, '/')).toBe(true);
  });

  it('treats empty Disallow as allow-all and handles disallow-all', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow:'), '/anything')).toBe(true);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /'), '/anything')).toBe(false);
    expect(isAllowed({ rules: [], disallowAll: true }, '/')).toBe(false);
  });
});
