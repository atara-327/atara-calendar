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
 * AUTH_MODE=dev を効かせるリクエストの宛先。AUTH_MODE の値だけで決めないのは、誤って本番に
 * 値が入ったとき、本番のドメインでも認証が外れてしまうため。
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

function isLocalRequest(url: string): boolean {
  return LOCAL_HOSTNAMES.has(new URL(url).hostname);
}

/**
 * 403 の本文には理由を入れない。どこで弾かれたかは、攻撃者への手がかりになるため。
 * 理由は、ログ（wrangler tail）にだけ残す。
 */
function forbidden(c: Context<AppEnv>, reason: string) {
  console.warn(`[auth] 403: ${reason}`);
  return c.json({ error: 'forbidden' }, 403);
}

/**
 * ACCESS_TEAM_DOMAIN に許す書式。ホスト名だけ（<チーム名>.cloudflareaccess.com）。
 * https:// や / が付いた値を受け取って取り除く形にしないのは、設定の誤りを黙って直すより、
 * 500 とログで気づける方が確実なため。通してしまうと、公開鍵の URL と iss が壊れて、
 * どの JWT も 403 になり、原因が分かりにくい。
 */
const TEAM_DOMAIN_PATTERN = /^[a-z0-9.-]+$/i;

/** 未設定と空白だけの値を、どちらも空文字にそろえる。 */
function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

/**
 * 検証に失敗した理由。JOSEError は code で原因が決まる。それ以外（公開鍵の取得の失敗など）は
 * code がないので、message も残す。
 */
function describeError(error: unknown): string {
  if (error instanceof errors.JOSEError) return error.code;
  return error instanceof Error ? `unknown: ${error.message}` : 'unknown';
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
      if (isLocalRequest(c.req.url)) {
        c.set('actor', DEV_ACTOR);
        await next();
        return;
      }
      console.warn(
        '[auth] AUTH_MODE=dev は localhost・127.0.0.1 以外では効かないので、JWT を検証します',
      );
    }

    const teamDomain = clean(env.ACCESS_TEAM_DOMAIN);
    const audience = clean(env.ACCESS_AUD);
    const allowedEmail = clean(env.ALLOWED_EMAIL);
    if (teamDomain === '' || audience === '' || allowedEmail === '') {
      // 403 ではなく 500 にするのは、リクエストが悪いのではなく、こちらの設定漏れだから。
      console.error('[auth] ACCESS_TEAM_DOMAIN・ACCESS_AUD・ALLOWED_EMAIL のどれかが空です');
      return c.json({ error: 'internal_error' }, 500);
    }
    if (!TEAM_DOMAIN_PATTERN.test(teamDomain)) {
      console.error(
        '[auth] ACCESS_TEAM_DOMAIN は <チーム名>.cloudflareaccess.com の形で書いてください（https:// や / は付けません）',
      );
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
      return forbidden(c, `JWT の検証に失敗しました (${describeError(error)})`);
    }

    const actor = identify(payload, allowedEmail, clean(env.ALLOWED_SERVICE_TOKEN_ID));
    if (actor === null) {
      return forbidden(c, '許可されていない相手です');
    }

    c.set('actor', actor);
    await next();
  });
}
