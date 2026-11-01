// MCP サーバー（mcp/）を、依存を含めた 1 つの JS ファイル（mcp/dist/index.js）にまとめる（設計書 13.1）。
// Why まとめるのか: .mcpb には node_modules を入れず、Claude Desktop 付属の Node で動かすため。
import { build } from 'esbuild';

await build({
  entryPoints: ['mcp/index.ts'],
  outfile: 'mcp/dist/index.js',
  bundle: true,
  platform: 'node',
  // Claude Desktop 付属の Node（manifest.json の compatibility.runtimes.node と合わせる）。
  target: 'node18',
  format: 'esm',
  // 依存パッケージの CommonJS（require を使うもの）が、ESM の出力の中で動くようにする。
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
