import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { changesRoute } from './changes';
import { entriesRoute } from './entries';
import { handleNotFound } from './errors';
import { occurrencesRoute } from './occurrences';
import { workspacesRoute } from './workspaces';

/** /api の各エンドポイント（設計書 5.1）。認証などのミドルウェアは、worker/index.ts が、この前に付ける。 */
export const api = new Hono<AppEnv>();

api.route('/changes', changesRoute);
api.route('/workspaces', workspacesRoute);
api.route('/entries', entriesRoute);
api.route('/occurrences', occurrencesRoute);

// 上のどのエンドポイントにも当たらないものを、JSON の 404 にする。app.notFound にしないのは、アプリ全体の
// 404 になり、/api/ の外のパスの扱いまで変わってしまうため（パスで分ける処理も要る）。
api.all('*', handleNotFound);
