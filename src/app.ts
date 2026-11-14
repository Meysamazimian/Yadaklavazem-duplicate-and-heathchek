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
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Unauthenticated liveness probe (reveals nothing).
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

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
    setSession(res, config.cookieSecure);
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
