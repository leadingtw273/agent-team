import { acquireFileLock } from "../../dist/infrastructure/files/index.js";

const lockPath = process.argv[2];
if (lockPath === undefined || process.send === undefined) process.exit(2);

const acquired = await acquireFileLock(lockPath, `crash-fixture:${String(process.pid)}`);
if (!acquired.ok) {
  process.send({ state: "failed", code: acquired.error.code });
  process.exit(3);
}

process.send({ state: "held" });
setInterval(() => undefined, 60_000);
