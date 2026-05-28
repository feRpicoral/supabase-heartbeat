import { runHeartbeat } from './heartbeat-lib.mjs';

try {
  const result = await runHeartbeat();
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

