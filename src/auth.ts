import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from './config';

const COOKIE = 'dm_session';
const SESSION_HOURS = 12;

const secret = (): string => config.sessionSecret || crypto.createHash('sha256').update('dm:' + config.dashboardPassword).digest('hex');
const sign = (payload: string): string => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

export const safeEqual = (a: string, b: string): boolean => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

export const issueToken = (now = Date.now()): string => {
  const exp = String(now + SESSION_HOURS * 3600_000);
  return `${exp}.${sign(exp)}`;
};

export const verifyToken = (token: string | undefined, now = Date.now()): boolean => {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < now) return false;
  return safeEqual(sig, sign(exp));
};

const readCookie = (req: Request, name: string): string | undefined => {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
};

export const isAuthenticated = (req: Request): boolean => verifyToken(readCookie(req, COOKIE));

export const setSession = (res: Response, secure: boolean): void => {
  res.cookie(COOKIE, issueToken(), { httpOnly: true, sameSite: 'strict', secure, maxAge: SESSION_HOURS * 3600_000, path: '/' });
};
export const clearSession = (res: Response): void => {
  res.clearCookie(COOKIE, { path: '/' });
};

// Login brute-force limiter: 5 failures per IP per 15 minutes.
const failures = new Map<string, { count: number; resetAt: number }>();
export const loginBlocked = (ip: string): boolean => {
  const f = failures.get(ip);
  if (!f) return false;
  if (f.resetAt < Date.now()) {
    failures.delete(ip);
    return false;
  }
  return f.count >= 5;
};
export const recordLoginFailure = (ip: string): void => {
  const f = failures.get(ip);
  if (!f || f.resetAt < Date.now()) failures.set(ip, { count: 1, resetAt: Date.now() + 15 * 60_000 });
  else f.count++;
};

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (isAuthenticated(req)) return next();
  if (req.originalUrl.startsWith('/api/')) {
    res.status(401).json({ ok: false, error: 'unauthenticated' });
    return;
  }
  res.status(200).type('html').send(loginPage());
};

export const loginPage = (error?: string): string => `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ورود به داشبورد پایش</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;font-family:Tahoma,"Segoe UI",sans-serif;color:#e2e8f0}
form{background:#1e293b;padding:32px;border-radius:14px;width:min(340px,90vw);display:grid;gap:14px;box-shadow:0 10px 30px #0006}
h1{margin:0;font-size:18px}input,button{font:inherit;padding:11px 12px;border-radius:8px;border:1px solid #475569}
input{background:#0f172a;color:inherit;direction:ltr;text-align:left}button{background:#2563eb;color:#fff;border:0;cursor:pointer}
.err{color:#fca5a5;font-size:13px}
</style></head><body>
<form method="post" action="/login"><h1>داشبورد پایش و دوپلیکیت</h1>
${error ? `<div class="err">${error}</div>` : ''}
<input type="password" name="password" placeholder="رمز عبور" autofocus required>
<button type="submit">ورود</button></form></body></html>`;
