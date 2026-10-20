import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Actor, AppEnv } from './env';

/** Access のチームのドメインから、JWT の署名を確かめる公開鍵の取得関数を作る。 */
export type KeyResolver = (teamDomain: string) => JWTVerifyGetKey;

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

/**
 * Access の証明書 URL から公開鍵を取る。リクエストのたびに createRemoteJWKSet を作り直さないのは、
 * 取得した鍵のキャッシュがその関数の中にあり、作り直すたびに毎回 Access へ取りに行くことになるため。
 * isolate の間は使い回す。
 */
export const remoteKeyResolver: KeyResolver = (teamDomain) => {
  let keySet = remoteKeySets.get(teamDomain);
  if (keySet === undefined) {
    keySet = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    remoteKeySets.set(teamDomain, keySet);
  }
  return keySet;
};

const DEV_ACTOR: Actor = { kind: 'user', email: 'dev@localhost' };

/**
 * 403 の本文には理由を入れない。どこで弾かれたかは、攻撃者への手がかりになるため。
 * 理由は、ログ（wrangler tail）にだけ残す。
 */
function forbidden(c: Context<AppEnv>, reason: string) {
  console.warn(`[auth] 403: ${reason}`);
  return c.json({ error: 'forbidden' }, 403);
}

/** 未設定と空白だけの値を、どちらも空文字にそろえる。 */
function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

function identify(
  payload: JWTPayload,
  allowedEmail: string,
  allowedServiceTokenId: string,
): Actor | null {
  const { email, common_name: commonName } = payload;
  if (typeof email === 'string' && email.toLowerCase() === allowedEmail.toLowerCase()) {
    return { kind: 'user', email };
  }
  // サービストークンの JWT には email が付かず、common_name に Client ID が入る。
  // 許可する ID が空のときは比較しない（空の common_name と一致して通ってしまうのを防ぐ）。
  if (allowedServiceTokenId !== '' && commonName === allowedServiceTokenId) {
    return { kind: 'service' };
  }
  return null;
}

/**
 * Access が付ける JWT（Cf-Access-Jwt-Assertion）を検証し、許可した相手だけを通す（設計書 10.2）。
 * keyResolver はテストで鍵を差し替えるためのもの。
 */
export function accessAuth(options: { keyResolver?: KeyResolver } = {}) {
  const resolveKey = options.keyResolver ?? remoteKeyResolver;

  return createMiddleware<AppEnv>(async (c, next) => {
    const env = c.env;

    if (env.AUTH_MODE === 'dev') {
      c.set('actor', DEV_ACTOR);
      await next();
      return;
    }

    const teamDomain = clean(env.ACCESS_TEAM_DOMAIN);
    const audience = clean(env.ACCESS_AUD);
    const allowedEmail = clean(env.ALLOWED_EMAIL);
    if (teamDomain === '' || audience === '' || allowedEmail === '') {
      // 403 ではなく 500 にするのは、リクエストが悪いのではなく、こちらの設定漏れだから。
      console.error('[auth] ACCESS_TEAM_DOMAIN・ACCESS_AUD・ALLOWED_EMAIL のどれかが空です');
      return c.json({ error: 'internal_error' }, 500);
    }

    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (token === undefined || token === '') {
      return forbidden(c, 'JWT のヘッダーがありません');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, resolveKey(teamDomain), {
        issuer: `https://${teamDomain}`,
        audience,
        algorithms: ['RS256'],
        // 期限のない JWT は、jose の既定では通ってしまう。
        requiredClaims: ['exp'],
      }));
    } catch (error) {
      const code = error instanceof errors.JOSEError ? error.code : 'unknown';
      return forbidden(c, `JWT の検証に失敗しました (${code})`);
    }

    const actor = identify(payload, allowedEmail, clean(env.ALLOWED_SERVICE_TOKEN_ID));
    if (actor === null) {
      return forbidden(c, '許可されていない相手です');
    }

    c.set('actor', actor);
    await next();
  });
}
