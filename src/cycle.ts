import os from 'os';
import { config, validateConfig } from './config';
import { closeDbs, dst } from './db';
import { addEvent, ensureMeta, getState, setState } from './meta';
import { runReplication, ReplicationResult } from './replicator';
import { MonitorResult, pruneHistory, runHealthChecks } from './monitor';

export interface CycleResult {
  started: boolean;
  reason?: string;
  replication?: ReplicationResult | { error: string };
  monitor?: MonitorResult | { error: string };
}

const holder = `${os.hostname()}-${process.pid}`;
let running = false;

async function acquireLock(): Promise<boolean> {
  const db = dst();
  const now = new Date();
  await db('__mon_lock').insert({ name: 'cycle', locked_until: new Date(0), holder: null }).onConflict('name').ignore();
  const ttl = (config.replicate.maxSeconds + 180) * 1000;
  const updated = await db('__mon_lock')
    .where({ name: 'cycle' })
    .andWhere('locked_until', '<', now)
    .update({ locked_until: new Date(now.getTime() + ttl), holder });
  return updated === 1;
}

async function releaseLock(): Promise<void> {
  await dst()('__mon_lock').where({ name: 'cycle', holder }).update({ locked_until: new Date(0) });
}

export async function isDue(): Promise<boolean> {
  const last = await getState('last_cycle_started');
  if (!last) return true;
  return Date.now() - Number(last) >= config.cycleIntervalMinutes * 60_000 - 15_000;
}

/** One loop: replicate the database and health-check the backend at the same time. Overlap-safe across processes. */
export async function runCycle(trigger: string): Promise<CycleResult> {
  if (running) return { started: false, reason: 'a cycle is already running in this process' };
  running = true;
  try {
    if (!(await acquireLock())) return { started: false, reason: 'a cycle is already running (lock held)' };
    try {
      await setState('last_cycle_started', String(Date.now()));
      const [repl, mon] = await Promise.allSettled([runReplication(trigger), runHealthChecks()]);
      const result: CycleResult = { started: true };
      if (repl.status === 'fulfilled') result.replication = repl.value;
      else {
        result.replication = { error: String(repl.reason?.message || repl.reason) };
        await addEvent('error', 'replication_failed', null, String(repl.reason?.message || repl.reason));
      }
      if (mon.status === 'fulfilled') result.monitor = mon.value;
      else {
        result.monitor = { error: String(mon.reason?.message || mon.reason) };
        await addEvent('error', 'monitor_failed', null, String(mon.reason?.message || mon.reason));
      }
      await pruneHistory().catch((e) => console.error('[prune]', e.message));
      await setState('last_cycle_finished', String(Date.now()));
      return result;
    } finally {
      await releaseLock().catch(() => undefined);
    }
  } finally {
    running = false;
  }
}

export async function runIfDue(trigger: string): Promise<CycleResult> {
  if (!(await isDue())) return { started: false, reason: 'not due yet' };
  return runCycle(trigger);
}

let timer: NodeJS.Timeout | null = null;

/** In-process scheduler: wakes every 30s and starts a cycle when one is due (so it also coexists with cron hits). */
export function startScheduler(): void {
  if (timer) return;
  const tick = () => {
    runIfDue('scheduler').catch((err) => console.error('[scheduler] cycle failed:', err.message));
  };
  timer = setInterval(tick, 30_000);
  timer.unref?.();
  setTimeout(tick, 3_000).unref?.();
}

// `node dist/cycle.js` => run one cycle (for a cPanel cron job) and exit.
if (require.main === module) {
  (async () => {
    const problems = validateConfig().filter((p) => !p.includes('DASHBOARD_PASSWORD'));
    if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
    await ensureMeta();
    const force = process.argv.includes('--force');
    const res = force ? await runCycle('cron') : await runIfDue('cron');
    console.log(JSON.stringify(res));
    await closeDbs();
  })().catch(async (err) => {
    console.error(err);
    await closeDbs();
    process.exit(1);
  });
}
