import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { changesRoute } from './changes';
import { entriesRoute } from './entries';
import { occurrencesRoute } from './occurrences';
import { workspacesRoute } from './workspaces';

/** /api の各エンドポイント（設計書 5.1）。認証などのミドルウェアは、worker/index.ts が、この前に付ける。 */
export const api = new Hono<AppEnv>();

api.route('/changes', changesRoute);
api.route('/workspaces', workspacesRoute);
api.route('/entries', entriesRoute);
api.route('/occurrences', occurrencesRoute);
