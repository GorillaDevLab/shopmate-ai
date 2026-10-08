import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

export function restartedLatestRead(env, actor, scope, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [fileURLToPath(import.meta.url), "child"],
      {
        env: { ...process.env, ...env },
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 300_000,
      },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    child.stdin.end(JSON.stringify({ actor, scope, input }));
  });
}

async function childRead() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk.toString("utf8"));
  const { actor, scope, input } = JSON.parse(chunks.join(""));
  const source = await import("../../dist/src/mock-platform/index.js");
  const reader = source.createMockSourceReader(process.env);
  try {
    process.stdout.write(JSON.stringify(await reader.readLatestStates(actor, scope, input)));
  } finally {
    await reader.close();
  }
}

if (process.argv[2] === "child") {
  try {
    await childRead();
  } catch (error) {
    process.stderr.write(error.code ?? "RESTART_READ_FAILED");
    process.exitCode = 1;
  }
}
