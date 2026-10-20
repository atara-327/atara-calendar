import { Hono } from 'hono';
import { api } from './api';
import { handleError } from './api/errors';
import { accessAuth } from './auth';
import type { AppEnv } from './env';
import { apiSecurityHeaders, guardRequests } from './security';

export const app = new Hono<AppEnv>();

// 順番が大事。ヘッダーを先に付けるので、認証の 403 にも付く。認証をリクエストの確認より先にするので、
// ログインしていない相手には、リクエストの確認の結果（415 など）を返さない。
app.use('/api/*', apiSecurityHeaders, accessAuth(), guardRequests);

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/api', api);

// 想定していない例外も、本文に中身を出さない 500 にする（Hono の既定は、本文が文字列の Internal Server Error）。
app.onError(handleError);

export default app;
