import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const valid = {
  ATARA_CALENDAR_BASE_URL: 'https://calendar.example.test',
  CF_ACCESS_CLIENT_ID: 'id',
  CF_ACCESS_CLIENT_SECRET: 'secret-value',
};

describe('MCP サーバーの設定（MC-4）', () => {
  it('環境変数から、ベース URL・Client ID・Client Secret を読む', () => {
    expect(loadConfig(valid)).toEqual({
      baseUrl: 'https://calendar.example.test',
      clientId: 'id',
      clientSecret: 'secret-value',
    });
  });

  it('ベース URL の末尾のスラッシュは取り除く', () => {
    expect(
      loadConfig({ ...valid, ATARA_CALENDAR_BASE_URL: 'https://calendar.example.test//' }),
    ).toMatchObject({ baseUrl: 'https://calendar.example.test' });
  });

  it('足りない変数があれば、その名前を挙げて断る', () => {
    expect(() => loadConfig({ ...valid, CF_ACCESS_CLIENT_ID: undefined })).toThrow(
      /CF_ACCESS_CLIENT_ID/,
    );
    expect(() => loadConfig({ ...valid, CF_ACCESS_CLIENT_SECRET: '  ' })).toThrow(
      /CF_ACCESS_CLIENT_SECRET/,
    );
  });

  it('https でない URL は、トークンを平文で送らないよう断る', () => {
    expect(() =>
      loadConfig({ ...valid, ATARA_CALENDAR_BASE_URL: 'http://calendar.example.test' }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, ATARA_CALENDAR_BASE_URL: 'calendar' })).toThrow(
      ConfigError,
    );
  });

  it('エラーの文言に、Client Secret を含めない', () => {
    try {
      loadConfig({ ...valid, ATARA_CALENDAR_BASE_URL: 'http://x' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  });
});
