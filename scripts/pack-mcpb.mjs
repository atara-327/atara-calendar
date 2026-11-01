// MCP サーバーの拡張機能（mcp/dist/atara-calendar.mcpb）を作る（設計書 13.1）。先に npm run build:mcp を実行しておく。
// mcp/ をそのまま pack せず、manifest.json と server/index.js だけの作業用のフォルダを作って pack する。
// Why: mcp/ をそのまま pack すると、ソースコードとテストまで入るため。
import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';

const stage = 'mcp/dist/mcpb-stage';
const output = 'mcp/dist/atara-calendar.mcpb';

await rm(stage, { recursive: true, force: true });
await mkdir(`${stage}/server`, { recursive: true });
await cp('mcp/manifest.json', `${stage}/manifest.json`);
await cp('mcp/dist/index.js', `${stage}/server/index.js`);

execFileSync('npx', ['--no-install', 'mcpb', 'pack', stage, output], { stdio: 'inherit' });
await rm(stage, { recursive: true, force: true });
