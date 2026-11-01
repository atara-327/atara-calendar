import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from './messages';
import {
  createEventInputSchema,
  createWorkspaceInputSchema,
  deleteEventInputSchema,
  listEventsInputSchema,
  listWorkspacesInputSchema,
  updateEventInputSchema,
} from './toolSchemas';
import type { Tools } from './tools';

// MCP の SDK に、6 つのツール（設計書 13.3）を登録する。判断は tools.ts にあり、ここは入力の検証と結果の包みだけ。

function toCallToolResult({ ok, text }: ToolResult): CallToolResult {
  return { content: [{ type: 'text', text }], isError: !ok };
}

const OCCURRENCE_NOTE =
  '対象の回は、list_events の結果の seriesId・occurrenceDate・recurring で指す。';

export function createServer(tools: Tools): McpServer {
  const server = new McpServer({ name: 'atara-calendar', version: '1.0.0' });

  server.registerTool(
    'list_events',
    {
      description:
        'カレンダーの、期間内の予定・タイムブロックを、繰り返しを展開して返す。祝日と記念日も返す（holidays・observances）。' +
        '各回には、ワークスペースの名前（workspaceName）が付く。タイムブロックは、ワークスペースがない（null）。' +
        '更新・削除では、各回の seriesId・occurrenceDate・recurring を使う。' +
        '日付は日本時間の YYYY-MM-DD、時刻は日本時間の HH:MM。期間は最大 366 日。' +
        '予定のまとめ（サマリ）は、この結果から作る。',
      inputSchema: listEventsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => toCallToolResult(await tools.listEvents(input)),
  );

  server.registerTool(
    'list_workspaces',
    {
      description:
        'ワークスペースの一覧（id・名前・色）を、並び順で返す。create_event の workspaceId は、ここで調べる。' +
        '組み込みの「祝日」「記念日」は含まない（予定を入れられないため）。',
      inputSchema: listWorkspacesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => toCallToolResult(await tools.listWorkspaces()),
  );

  server.registerTool(
    'create_event',
    {
      description:
        '予定（kind が event）かタイムブロック（block）を作る。繰り返しも指定できる（rrule）。' +
        '日付は日本時間の YYYY-MM-DD、時刻は日本時間の HH:MM（分は 00・15・30・45）。' +
        '予定はワークスペースが必要（list_workspaces で調べる）。',
      inputSchema: createEventInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => toCallToolResult(await tools.createEvent(input)),
  );

  server.registerTool(
    'update_event',
    {
      description:
        '予定・タイムブロックの、変える項目だけを変える。' +
        OCCURRENCE_NOTE +
        '繰り返す予定は、scope で範囲を選ぶ: this（この回のみ）・following（この回以降すべて）・all（すべての回）。' +
        '日付は日本時間の YYYY-MM-DD、時刻は日本時間の HH:MM。',
      inputSchema: updateEventInputSchema,
    },
    async (input) => toCallToolResult(await tools.updateEvent(input)),
  );

  server.registerTool(
    'delete_event',
    {
      description:
        '予定・タイムブロックを消す。' +
        OCCURRENCE_NOTE +
        '繰り返す予定は、scope で範囲を選ぶ: this（この回のみ）・following（この回以降すべて）・all（すべての回）。' +
        '消す前に、利用者に、どの予定のどの範囲かを確かめる。',
      inputSchema: deleteEventInputSchema,
      annotations: { destructiveHint: true },
    },
    async (input) => toCallToolResult(await tools.deleteEvent(input)),
  );

  server.registerTool(
    'create_workspace',
    {
      description:
        'ワークスペースを作る。名前・色の変更と削除は、このツールではできない（画面でやる）。' +
        '色は名前で選ぶ（省略すると、まだ使っていない色の先頭）。',
      inputSchema: createWorkspaceInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => toCallToolResult(await tools.createWorkspace(input)),
  );

  return server;
}
