import { Hono } from 'hono';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
  type CryptoKey,
} from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessAuth, remoteKeyResolver } from './auth';
import type { AppEnv, Bindings } from './env';

const TEAM_DOMAIN = 'example-team.cloudflareaccess.com';
const AUD = 'test-audience';
const EMAIL = 'me@example.com';
const SERVICE_TOKEN_ID = 'test-client-id.access';
const KID = 'test-key';

const baseEnv: Bindings = {
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD: AUD,
  ALLOWED_EMAIL: EMAIL,
};

let trusted: { publicKey: CryptoKey; privateKey: CryptoKey };
let untrusted: { publicKey: CryptoKey; privateKey: CryptoKey };
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  trusted = await generateKeyPair('RS256');
  untrusted = await generateKeyPair('RS256');
  publicJwk = { ...(await exportJWK(trusted.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface JwtOptions {
  /** 既定は { email: EMAIL }。 */
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string | string[];
  /** 秒。null なら期限（exp）を付けない。既定は 1 時間後。 */
  expiresAt?: number | null;
  privateKey?: CryptoKey;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** 既定では、Access が付けるものと同じ形の、正しい JWT を作る。 */
async function makeJwt(options: JwtOptions = {}): Promise<string> {
  const jwt = new SignJWT(options.claims ?? { email: EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(options.issuer ?? `https://${TEAM_DOMAIN}`)
    .setAudience(options.audience ?? AUD)
    .setIssuedAt();
  if (options.expiresAt !== null) {
    jwt.setExpirationTime(options.expiresAt ?? nowSeconds() + 3600);
  }
  return jwt.sign(options.privateKey ?? trusted.privateKey);
}

function buildApp(keyResolver = () => createLocalJWKSet({ keys: [publicJwk] })) {
  const app = new Hono<AppEnv>();
  app.use('/api/*', accessAuth({ keyResolver }));
  app.get('/api/whoami', (c) => c.json(c.var.actor));
  return app;
}

/** jwt が null ならヘッダーを付けない。url を省かなければ、宛先は http://localhost になる。 */
function call(jwt: string | null, env: Partial<Bindings> = {}, url = '/api/whoami') {
  const headers: Record<string, string> = jwt === null ? {} : { 'Cf-Access-Jwt-Assertion': jwt };
  return buildApp().request(url, { headers }, { ...baseEnv, ...env });
}

describe('Access の JWT の検証（AU-1・NF-2）', () => {
  it('正しい JWT を持つ本人は 200 で、本人として扱う', async () => {
    const res = await call(await makeJwt());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'user', email: EMAIL });
  });

  it('メールアドレスの大文字小文字の違いは通す', async () => {
    const res = await call(await makeJwt({ claims: { email: 'Me@Example.COM' } }));

    expect(res.status).toBe(200);
  });

  it('aud が配列（Access の JWT の形）で、自分の宛先を含んでいれば通す', async () => {
    const res = await call(await makeJwt({ audience: ['other-audience', AUD] }));

    expect(res.status).toBe(200);
  });

  it('ヘッダーがなければ 403', async () => {
    const res = await call(null);

    expect(res.status).toBe(403);
  });

  it('ヘッダーが空なら 403', async () => {
    const res = await call('');

    expect(res.status).toBe(403);
  });

  it('JWT の形をしていない値は 403', async () => {
    const res = await call('not-a-jwt');

    expect(res.status).toBe(403);
  });

  it('信頼する鍵とは別の鍵で署名された JWT は 403', async () => {
    const res = await call(await makeJwt({ privateKey: untrusted.privateKey }));

    expect(res.status).toBe(403);
  });

  it('署名したあとに中身（メールアドレス）を書き換えた JWT は 403', async () => {
    // 別の人の JWT の署名に、許可されたメールアドレスの中身を付け替える。
    const [header, , signature] = (await makeJwt({ claims: { email: 'other@example.com' } })).split(
      '.',
    );
    const [, payload] = (await makeJwt()).split('.');

    const res = await call([header, payload, signature].join('.'));

    expect(res.status).toBe(403);
  });

  it('期限が切れた JWT は 403', async () => {
    const res = await call(await makeJwt({ expiresAt: nowSeconds() - 60 }));

    expect(res.status).toBe(403);
  });

  it('期限（exp）のない JWT は 403', async () => {
    const res = await call(await makeJwt({ expiresAt: null }));

    expect(res.status).toBe(403);
  });

  it('aud が違う JWT は 403', async () => {
    const res = await call(await makeJwt({ audience: 'other-audience' }));

    expect(res.status).toBe(403);
  });

  it('iss が違う JWT は 403', async () => {
    const res = await call(await makeJwt({ issuer: 'https://other-team.cloudflareaccess.com' }));

    expect(res.status).toBe(403);
  });

  it('許可していないメールアドレスの JWT は 403', async () => {
    const res = await call(await makeJwt({ claims: { email: 'other@example.com' } }));

    expect(res.status).toBe(403);
  });

  it('メールアドレスがなく、サービストークンでもない JWT は 403', async () => {
    const res = await call(await makeJwt({ claims: { sub: 'someone' } }));

    expect(res.status).toBe(403);
  });

  it('署名の方式が RS256 でない JWT は 403（HS256 に差し替える攻撃を止める）', async () => {
    const jwt = await new SignJWT({ email: EMAIL })
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('shared-secret-shared-secret-shared'));

    const res = await call(jwt);

    expect(res.status).toBe(403);
  });

  it('鍵が正しくても、署名の方式が RS256 でなければ 403', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS384');
    // alg を書かない鍵の一覧にして、鍵の側の絞り込みに頼らず、方式の制限だけで弾けることを確かめる。
    const keys = [{ ...(await exportJWK(publicKey)), kid: KID }];
    const jwt = await new SignJWT({ email: EMAIL })
      .setProtectedHeader({ alg: 'RS384', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setExpirationTime('1h')
      .sign(privateKey);

    const res = await buildApp(() => createLocalJWKSet({ keys })).request(
      '/api/whoami',
      { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
      baseEnv,
    );

    expect(res.status).toBe(403);
  });

  it('署名のない JWT（alg: none）は 403', async () => {
    const jwt = new UnsecuredJWT({ email: EMAIL })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setExpirationTime('1h')
      .encode();

    const res = await call(jwt);

    expect(res.status).toBe(403);
  });

  it('403 の本文には、どこで弾かれたかの手がかりを入れない', async () => {
    const bodies = await Promise.all(
      [
        null,
        await makeJwt({ expiresAt: nowSeconds() - 60 }),
        await makeJwt({ audience: 'other-audience' }),
        await makeJwt({ claims: { email: 'other@example.com' } }),
      ].map(async (jwt) => (await call(jwt)).text()),
    );

    expect(new Set(bodies)).toEqual(new Set(['{"error":"forbidden"}']));
  });

  it('弾いた理由は、本文ではなくログに残す', async () => {
    await call(await makeJwt({ expiresAt: nowSeconds() - 60 }));

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ERR_JWT_EXPIRED'));
  });

  it('公開鍵は、ACCESS_TEAM_DOMAIN のドメインについて取得する', async () => {
    const keyResolver = vi.fn(() => createLocalJWKSet({ keys: [publicJwk] }));

    await buildApp(keyResolver).request(
      '/api/whoami',
      { headers: { 'Cf-Access-Jwt-Assertion': await makeJwt() } },
      baseEnv,
    );

    expect(keyResolver).toHaveBeenCalledWith(TEAM_DOMAIN);
  });
});

describe('サービストークン（AU-1・NF-2。将来の MCP 用）', () => {
  const serviceClaims = { common_name: SERVICE_TOKEN_ID };

  it('許可する ID を設定していて、common_name が一致すれば 200', async () => {
    const res = await call(await makeJwt({ claims: serviceClaims }), {
      ALLOWED_SERVICE_TOKEN_ID: SERVICE_TOKEN_ID,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'service' });
  });

  it('許可する ID を設定していなければ 403', async () => {
    const res = await call(await makeJwt({ claims: serviceClaims }));

    expect(res.status).toBe(403);
  });

  it('許可する ID が空なら、common_name が空の JWT でも 403', async () => {
    const res = await call(await makeJwt({ claims: { common_name: '' } }), {
      ALLOWED_SERVICE_TOKEN_ID: '',
    });

    expect(res.status).toBe(403);
  });

  it('許可する ID が空白だけなら、common_name が空白だけの JWT でも 403', async () => {
    const res = await call(await makeJwt({ claims: { common_name: '  ' } }), {
      ALLOWED_SERVICE_TOKEN_ID: '  ',
    });

    expect(res.status).toBe(403);
  });

  it('common_name が別の ID なら 403', async () => {
    const res = await call(await makeJwt({ claims: { common_name: 'other-client-id.access' } }), {
      ALLOWED_SERVICE_TOKEN_ID: SERVICE_TOKEN_ID,
    });

    expect(res.status).toBe(403);
  });

  it('common_name が一致しても、署名が正しくなければ 403', async () => {
    const res = await call(
      await makeJwt({ claims: serviceClaims, privateKey: untrusted.privateKey }),
      { ALLOWED_SERVICE_TOKEN_ID: SERVICE_TOKEN_ID },
    );

    expect(res.status).toBe(403);
  });
});

describe('AUTH_MODE（手元の開発用。NF-2）', () => {
  it('dev のときは、JWT がなくても通す', async () => {
    const res = await call(null, { AUTH_MODE: 'dev' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'user', email: 'dev@localhost' });
  });

  it.each([
    'http://localhost/api/whoami',
    'http://localhost:5173/api/whoami',
    'http://127.0.0.1:8787/api/whoami',
  ])('dev のときは、宛先が %s なら JWT がなくても通す', async (url) => {
    const res = await call(null, { AUTH_MODE: 'dev' }, url);

    expect(res.status).toBe(200);
  });

  it.each([
    'https://calendar.ataraman.com/api/whoami',
    'http://192.168.0.10:5173/api/whoami',
    'https://localhost.example.com/api/whoami',
    'https://127.0.0.1.example.com/api/whoami',
    'https://example.com/api/whoami?host=localhost',
  ])('dev でも、宛先が %s なら dev として扱わず、JWT を検証する', async (url) => {
    const res = await call(null, { AUTH_MODE: 'dev' }, url);

    expect(res.status).toBe(403);
  });

  it('dev でも、localhost 以外の宛先では、正しい JWT の本人として通す（dev の本人にはならない）', async () => {
    const res = await call(
      await makeJwt(),
      { AUTH_MODE: 'dev' },
      'https://calendar.ataraman.com/api/whoami',
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'user', email: EMAIL });
  });

  it('dev でも、localhost 以外の宛先では、Access の設定が空なら 500（設定の確認を省略しない）', async () => {
    const res = await call(
      null,
      { AUTH_MODE: 'dev', ACCESS_AUD: '' },
      'https://calendar.ataraman.com/api/whoami',
    );

    expect(res.status).toBe(500);
  });

  it('dev が効かなかったときは、ログで気づけるようにする', async () => {
    await call(null, { AUTH_MODE: 'dev' }, 'https://calendar.ataraman.com/api/whoami');

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('AUTH_MODE=dev'));
  });

  it('dev のときは、Access の設定が空でも通す（手元には Access がない）', async () => {
    const res = await call(null, {
      AUTH_MODE: 'dev',
      ACCESS_TEAM_DOMAIN: '',
      ACCESS_AUD: '',
      ALLOWED_EMAIL: undefined,
    });

    expect(res.status).toBe(200);
  });

  it.each(['production', 'DEV', ' dev', ''])(
    'AUTH_MODE が %j のときは dev として扱わず、JWT を検証する',
    async (authMode) => {
      const res = await call(null, { AUTH_MODE: authMode });

      expect(res.status).toBe(403);
    },
  );

  it('AUTH_MODE を設定していなければ、JWT を検証する', async () => {
    const res = await call(null);

    expect(res.status).toBe(403);
  });
});

describe('設定が空のときは拒否する（NF-2）', () => {
  it.each([
    ['ACCESS_TEAM_DOMAIN が空', { ACCESS_TEAM_DOMAIN: '' }],
    ['ACCESS_TEAM_DOMAIN が空白だけ', { ACCESS_TEAM_DOMAIN: '  ' }],
    ['ACCESS_AUD が空', { ACCESS_AUD: '' }],
    ['ACCESS_AUD が空白だけ', { ACCESS_AUD: '  ' }],
    ['ALLOWED_EMAIL が空', { ALLOWED_EMAIL: '' }],
    ['ALLOWED_EMAIL が未設定', { ALLOWED_EMAIL: undefined }],
    ['ALLOWED_EMAIL が空白だけ', { ALLOWED_EMAIL: '  ' }],
  ] satisfies [string, Partial<Bindings>][])(
    '%s なら、正しい JWT でも 500',
    async (_name, override) => {
      const res = await call(await makeJwt(), override);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error' });
    },
  );

  it.each([
    'https://example-team.cloudflareaccess.com',
    'example-team.cloudflareaccess.com/',
    'example-team.cloudflareaccess.com/cdn-cgi/access/certs',
    'example-team.cloudflareaccess.com:443',
    'example team.cloudflareaccess.com',
  ])(
    'ACCESS_TEAM_DOMAIN が %j のようにドメインの書式でなければ、正しい JWT でも 500',
    async (teamDomain) => {
      const res = await call(await makeJwt(), { ACCESS_TEAM_DOMAIN: teamDomain });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error' });
    },
  );

  it('ACCESS_TEAM_DOMAIN の書式の誤りは、理由をログに残す', async () => {
    await call(await makeJwt(), {
      ACCESS_TEAM_DOMAIN: 'https://example-team.cloudflareaccess.com',
    });

    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ACCESS_TEAM_DOMAIN'));
  });

  it('設定漏れは、ログで気づけるようにする', async () => {
    await call(await makeJwt(), { ACCESS_AUD: '' });

    expect(console.error).toHaveBeenCalledOnce();
  });

  it('メールアドレスが空のとき、空のメールアドレスの JWT を通してしまわない', async () => {
    const res = await call(await makeJwt({ claims: { email: '' } }), { ALLOWED_EMAIL: '' });

    expect(res.status).toBe(500);
  });
});

describe('公開鍵の取得（remoteKeyResolver）', () => {
  it('同じドメインには同じ取得関数を使い回し、別のドメインには別のものを返す', () => {
    const first = remoteKeyResolver('one.cloudflareaccess.com');

    expect(remoteKeyResolver('one.cloudflareaccess.com')).toBe(first);
    expect(remoteKeyResolver('two.cloudflareaccess.com')).not.toBe(first);
  });

  it('既定では Access の証明書 URL から鍵を取り、2 回目からは取りに行かない', async () => {
    const domain = 'fetch-test.cloudflareaccess.com';
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ keys: [publicJwk] })));
    vi.stubGlobal('fetch', fetchMock);
    const app = new Hono<AppEnv>();
    app.use('/api/*', accessAuth());
    app.get('/api/whoami', (c) => c.json(c.var.actor));
    const env: Bindings = { ...baseEnv, ACCESS_TEAM_DOMAIN: domain };
    const jwt = await makeJwt({ issuer: `https://${domain}` });

    const first = await app.request(
      '/api/whoami',
      { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
      env,
    );
    const second = await app.request(
      '/api/whoami',
      { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
      env,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://${domain}/cdn-cgi/access/certs`,
      expect.anything(),
    );
  });

  it('証明書 URL から鍵を取れなければ、通さない（403）', async () => {
    const domain = 'unreachable.cloudflareaccess.com';
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')));
    const app = new Hono<AppEnv>();
    app.use('/api/*', accessAuth());
    app.get('/api/whoami', (c) => c.json(c.var.actor));

    const res = await app.request(
      '/api/whoami',
      { headers: { 'Cf-Access-Jwt-Assertion': await makeJwt({ issuer: `https://${domain}` }) } },
      { ...baseEnv, ACCESS_TEAM_DOMAIN: domain },
    );

    expect(res.status).toBe(403);
  });

  it('JOSEError でない例外（鍵を取れないなど）は、ログに message も残す', async () => {
    const domain = 'unreachable-log.cloudflareaccess.com';
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')));
    const app = new Hono<AppEnv>();
    app.use('/api/*', accessAuth());
    app.get('/api/whoami', (c) => c.json(c.var.actor));

    await app.request(
      '/api/whoami',
      { headers: { 'Cf-Access-Jwt-Assertion': await makeJwt({ issuer: `https://${domain}` }) } },
      { ...baseEnv, ACCESS_TEAM_DOMAIN: domain },
    );

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('network down'));
  });
});
