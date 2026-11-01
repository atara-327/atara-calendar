import { z } from 'zod';

// MCP サーバーの設定。manifest.json の user_config から、環境変数で渡される（設計書 13.1）。
// 環境変数の名前は、manifest.json の mcp_config.env と合わせる。

export const ENV_NAMES = {
  baseUrl: 'ATARA_CALENDAR_BASE_URL',
  clientId: 'CF_ACCESS_CLIENT_ID',
  clientSecret: 'CF_ACCESS_CLIENT_SECRET',
} as const;

// サービストークンのヘッダーを平文の http で送らないよう、https だけを通す。
const httpsUrlSchema = z.url({ protocol: /^https$/ });

export interface Config {
  /** 末尾のスラッシュを除いた、API の土台の URL。 */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export class ConfigError extends Error {}

/**
 * 環境変数から設定を作る。足りない・形が違うときは、変数の名前だけを書いた ConfigError にする。
 * Why 値を入れないのか: Zod のエラー文や入力の値には、Client Secret が入りうる。ログ（標準エラー出力）に出さないため。
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const problems: string[] = [];
  const read = (name: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value === '') problems.push(`${name} が設定されていません`);
    return value ?? '';
  };

  const baseUrl = read(ENV_NAMES.baseUrl);
  const clientId = read(ENV_NAMES.clientId);
  const clientSecret = read(ENV_NAMES.clientSecret);
  if (baseUrl !== '' && !httpsUrlSchema.safeParse(baseUrl).success) {
    problems.push(`${ENV_NAMES.baseUrl} は https:// で始まる URL にしてください`);
  }
  if (problems.length > 0) throw new ConfigError(problems.join('。'));

  return { baseUrl: baseUrl.replace(/\/+$/, ''), clientId, clientSecret };
}
