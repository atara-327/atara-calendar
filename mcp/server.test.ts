import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WORKSPACE_COLORS } from '../src/shared/workspaceColors';
import { createFakeApi, createFakeDeps, jsonReply } from '../test/helpers/fakeApi';
import { createServer } from './server';
import { createTools } from './tools';

async function connect(respond: Parameters<typeof createFakeApi>[0]) {
  const fake = createFakeApi(respond);
  const server = createServer(createTools(createFakeDeps(fake.api)));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, requests: fake.requests };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? '';
}

describe('MCP のツールの登録（MC-1〜3）', () => {
  it('6 つのツールを出す', async () => {
    const { client } = await connect(() => jsonReply({}));
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual([
      'create_event',
      'create_workspace',
      'delete_event',
      'list_events',
      'list_workspaces',
      'update_event',
    ]);
  });

  it('update_event・delete_event の説明に、list_events が返す seriesId・occurrenceDate と、範囲（this・following・all）を書く', async () => {
    const { client } = await connect(() => jsonReply({}));
    const { tools } = await client.listTools();
    for (const name of ['update_event', 'delete_event']) {
      const description = tools.find((tool) => tool.name === name)?.description ?? '';
      for (const word of ['seriesId', 'occurrenceDate', 'this', 'following', 'all']) {
        expect(description, `${name} の説明に ${word} がありません`).toContain(word);
      }
    }
  });

  it('create_event の説明に、繰り返しの指定（rrule の 6 種類）と、日本時間の日付・時刻の形を書く', async () => {
    const { client } = await connect(() => jsonReply({}));
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === 'create_event');
    const text = JSON.stringify(tool);
    for (const freq of ['daily', 'weekly', 'monthly', 'yearly', 'weekday', 'holiday']) {
      expect(text).toContain(`\\"freq\\":\\"${freq}\\"`);
    }
    expect(text).toContain('YYYY-MM-DD');
    expect(text).toContain('HH:MM');
    expect(text).toContain('日本時間');
  });

  it('create_workspace の色は、8 色の名前から選ぶ', async () => {
    const { client } = await connect(() => jsonReply({}));
    const { tools } = await client.listTools();
    const schema = z
      .object({ properties: z.object({ color: z.object({ enum: z.array(z.string()) }) }) })
      .parse(tools.find(({ name }) => name === 'create_workspace')?.inputSchema);
    expect(schema.properties.color.enum).toEqual(WORKSPACE_COLORS.map(({ name }) => name));
  });

  it('消す・変えるツールは、破壊的でない印を付けない。作るツールは、破壊的でない印を付ける', async () => {
    const { client } = await connect(() => jsonReply({}));
    const { tools } = await client.listTools();
    const hint = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations?.destructiveHint;
    expect(hint('create_event')).toBe(false);
    expect(hint('create_workspace')).toBe(false);
    expect(hint('delete_event')).toBe(true);
    expect(hint('update_event')).not.toBe(false);
  });

  it('入力が合わなければ、API を呼ばずに、エラーで返す', async () => {
    const { client, requests } = await connect(() => jsonReply({}));
    const result = await client.callTool({
      name: 'list_events',
      arguments: { from: '2026-13-01', to: '2026-01-31' },
    });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('知らない項目を渡したら、黙って捨てずに断る', async () => {
    const { client, requests } = await connect(() => jsonReply({ applied: true }));
    const result = await client.callTool({
      name: 'delete_event',
      arguments: { seriesId: 's', occurrenceDate: '2026-10-19', scope: 'all', extra: 1 },
    });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('ツールの結果は、テキストで返し、反映できたときは isError にしない', async () => {
    const { client } = await connect(() => jsonReply({ applied: true }));
    const result = await client.callTool({
      name: 'delete_event',
      arguments: { seriesId: 's', occurrenceDate: '2026-10-19', scope: 'all' },
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe('削除しました（範囲: すべて）');
  });

  it('反映されなかったときは、isError にして、理由の文言を返す', async () => {
    const { client } = await connect(() => jsonReply({ applied: false, reason: 'not_found' }));
    const result = await client.callTool({
      name: 'delete_event',
      arguments: { seriesId: 's', occurrenceDate: '2026-10-19', scope: 'all' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('対象の予定（またはワークスペース）が見つかりません');
  });
});
