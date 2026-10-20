import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Workers の静的ファイルが読む _headers を、「パス → ヘッダー名 → 値」に読み替える。 */
function parseHeadersFile(text: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      const index = line.indexOf(':');
      current?.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
    } else {
      current = new Map();
      rules.set(line.trim(), current);
    }
  }
  return rules;
}

function parseCsp(csp: string): Map<string, string> {
  return new Map(
    csp
      .split(';')
      .map((directive) => directive.trim())
      .filter((directive) => directive !== '')
      .map((directive) => {
        const [name = '', ...values] = directive.split(/\s+/);
        return [name, values.join(' ')] as const;
      }),
  );
}

describe('画面（静的ファイル）のセキュリティヘッダー（NF-2。public/_headers）', () => {
  const rules = parseHeadersFile(read('public/_headers'));
  const all = rules.get('/*');

  it('すべてのパス（/*）に、ヘッダーを付ける', () => {
    expect([...rules.keys()]).toEqual(['/*']);
  });

  it('X-Content-Type-Options: nosniff と Referrer-Policy: no-referrer を付ける', () => {
    expect(all?.get('x-content-type-options')).toBe('nosniff');
    expect(all?.get('referrer-policy')).toBe('no-referrer');
  });

  it('CSP は、自分のドメインのスクリプト・スタイル・画像・フォント・通信だけを許し、埋め込みと外からの枠組みを禁じる', () => {
    const csp = parseCsp(all?.get('content-security-policy') ?? '');

    expect(Object.fromEntries(csp)).toEqual({
      'default-src': "'self'",
      'script-src': "'self'",
      'style-src': "'self'",
      'img-src': "'self'",
      'font-src': "'self'",
      'connect-src': "'self'",
      'object-src': "'none'",
      'base-uri': "'self'",
      'form-action': "'self'",
      'frame-ancestors': "'none'",
    });
  });

  it('画像は、自分のドメインのファイルだけを許す（data: の URL は許さない）', () => {
    const csp = parseCsp(all?.get('content-security-policy') ?? '');

    expect(csp.get('img-src')).toBe("'self'");
    expect(all?.get('content-security-policy')).not.toContain('data:');
  });
});

describe('index.html は、CSP で止まるものを含まない（NF-2）', () => {
  const html = read('index.html');

  it('中身を直接書いたスクリプト（インライン）がない', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).toMatch(/\bsrc=/);
  });

  it('onclick のようなイベントの属性や、style 属性がない', () => {
    expect(html).not.toMatch(/<[^>]+\s(on[a-z]+|style)\s*=/i);
  });
});
