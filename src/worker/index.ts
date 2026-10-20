import { Hono } from 'hono';
import { accessAuth } from './auth';
import type { AppEnv } from './env';
import { apiSecurityHeaders, guardWrites } from './security';

export const app = new Hono<AppEnv>();

// 順番が大事。ヘッダーを先に付けるので、認証の 403 にも付く。認証を書き込みの確認より先にするので、
// ログインしていない相手には、書き込みの確認の結果（415 など）を返さない。
app.use('/api/*', apiSecurityHeaders, accessAuth(), guardWrites);

app.get('/api/health', (c) => c.json({ ok: true }));

export default app;
