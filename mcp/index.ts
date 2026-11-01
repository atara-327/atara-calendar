import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config';
import { createEditedAtClock } from './editedAtClock';
import { createServer } from './server';
import { createTools } from './tools';

// Claude Desktop が、標準入出力でつなぐ入口（設計書 13.1）。
// ログは、標準エラー出力だけに出す。標準出力は、MCP のやり取り専用のため（設計書 13.2）。
// Client Secret などの設定値は、ログに出さない。

function log(message: string): void {
  process.stderr.write(`[atara-calendar] ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const tools = createTools({
    api: {
      fetch: globalThis.fetch.bind(globalThis),
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      // 送り直し（最大 2 回）を含めて 40 秒。MCP の SDK のリクエストの既定の待ち時間（60 秒）より先に返す。
      timeoutMs: 20_000,
      log,
    },
    newId: () => randomUUID(),
    nextEditedAt: createEditedAtClock(() => Date.now()),
  });
  await createServer(tools).connect(new StdioServerTransport());
  log(`起動しました（${config.baseUrl}）`);
}

main().catch((error: unknown) => {
  // 設定の誤りは、変数の名前だけの文言。それ以外は、メッセージだけ（スタックに値が入るのを避ける）。
  log(
    error instanceof ConfigError
      ? `設定が正しくありません: ${error.message}`
      : `起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
