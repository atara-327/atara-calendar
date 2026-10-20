import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { changesRoute } from './changes';
import { occurrencesRoute } from './occurrences';

/** /api の各エンドポイント（設計書 5.1）。認証などのミドルウェアは、worker/index.ts が、この前に付ける。 */
export const api = new Hono<AppEnv>();

api.route('/changes', changesRoute);
api.route('/occurrences', occurrencesRoute);
