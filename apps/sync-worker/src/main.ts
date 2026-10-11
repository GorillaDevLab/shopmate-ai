import { runSyncWorker } from "./cli.js";

runSyncWorker(process.env, process.argv.slice(2)).catch(() => {
  process.stderr.write("SYNC_WORKER_FAILED\n");
  process.exitCode = 1;
});
