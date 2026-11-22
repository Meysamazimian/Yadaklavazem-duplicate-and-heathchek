import { config, validateConfig } from './config';
import { createApp } from './app';
import { ensureMeta } from './meta';
import { runCycle, startScheduler } from './cycle';

const problems = validateConfig();
if (problems.length) {
  console.error(`[CONFIG ERROR]\n - ${problems.join('\n - ')}`);
  process.exit(1);
}

const app = createApp();

app.listen(config.port, '0.0.0.0', async () => {
  console.log(`Dashboard on port ${config.port}`);
  try {
    await ensureMeta();
    if (config.useMockDb) {
      await runCycle('startup');
    }
    if (config.enableScheduler) {
      startScheduler();
      console.log(`[scheduler] a cycle (replicate + health check) runs every ${config.cycleIntervalMinutes} min`);
    }
  } catch (err) {
    console.error('[startup] could not prepare the replica database:', (err as Error).message);
  }
});
