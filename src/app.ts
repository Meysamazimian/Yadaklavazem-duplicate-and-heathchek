import express from 'express';
import path from 'path';
import { config } from './config';
import { clearSession, isAuthenticated, loginBlocked, loginPage, recordLoginFailure, requireAuth, safeEqual, setSession } from './auth';
import apiRoutes from './api';
import { runIfDue, runCycle } from './cycle';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));
  app.use(express.json({ limit: '4kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Unauthenticated liveness probe (reveals nothing).
  app.get(['/healthz', '/health', '/api/health'], (_req, res) => {
    res.json({ ok: true });
  });

  if (config.useMockDb) {
    const demoSpecs: Record<string, Record<string, any>> = {
      storefront: {
        '/api/v1/storefront/products': { get: {} },
        '/api/v1/storefront/categories': { get: {} },
        '/api/v1/storefront/brands': { get: {} },
      },
      admin: {
        '/api/v1/admin/orders': { get: { security: [{ staffAuth: [] }] } },
        '/api/v1/admin/inventory': { get: { security: [{ staffAuth: [] }] } },
      },
      'admin-sales': {
        '/api/v1/sales/invoices': { get: { security: [{ staffAuth: [] }] } },
      },
      platform: {
        '/api/v1/platform/tenants': { get: { security: [{ platformAuth: [] }] } },
      },
    };
    app.get('/api/internal/swagger-docs/spec/:audience.json', (req, res) => {
      const paths = demoSpecs[req.params.audience] || {};
      res.json({ openapi: '3.0.0', paths });
    });
    app.get('/api/v1/storefront/*', (_req, res) => {
      res.json({ ok: true, items: [] });
    });
    app.get('/api/v1/*', (_req, res) => {
      res.status(401).json({ ok: false, error: 'unauthorized' });
    });
  }

  // cPanel cron: `curl -s "https://host/cron/run?key=CRON_KEY"` every few minutes. Responds at once; the cycle runs in the background.
  const cron = (req: express.Request, res: express.Response) => {
    const provided = String(req.query.key || req.headers['x-cron-key'] || '');
    if (!config.cronKey || !safeEqual(provided, config.cronKey)) {
      res.status(404).json({ ok: false });
      return;
    }
    const force = req.query.force === '1';
    const wait = req.query.wait === '1';
    const job = force ? runCycle('cron') : runIfDue('cron');
    if (wait) {
      job.then((r) => res.json({ ok: true, ...r })).catch((e) => res.status(500).json({ ok: false, error: e.message }));
    } else {
      job.catch((e) => console.error('[cron cycle]', e.message));
      res.status(202).json({ ok: true, accepted: true });
    }
  };
  app.get('/cron/run', cron);
  app.post('/cron/run', cron);

  app.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (loginBlocked(ip)) {
      res.status(429).type('html').send(loginPage('تعداد تلاش‌ها زیاد است؛ ۱۵ دقیقه بعد دوباره امتحان کنید.'));
      return;
    }
    const password = String(req.body?.password || '');
    if (!safeEqual(password, config.dashboardPassword)) {
      recordLoginFailure(ip);
      res.status(401).type('html').send(loginPage('رمز عبور نادرست است.'));
      return;
    }
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    setSession(res, config.cookieSecure && isHttps);
    res.redirect(303, '/');
  });

  app.post('/logout', (_req, res) => {
    clearSession(res);
    res.redirect(303, '/');
  });

  app.get('/session', (req, res) => {
    res.json({ authenticated: isAuthenticated(req) });
  });

  app.use('/api', requireAuth, apiRoutes);
  app.use(requireAuth, express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[error]', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  });
  return app;
}
