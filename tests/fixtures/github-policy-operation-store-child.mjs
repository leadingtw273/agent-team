import { FileGitHubPolicyOperationStore } from "../../dist/adapters/registration/index.js";
import { AtomicFileStore } from "../../dist/infrastructure/files/index.js";

const [root, operationId] = process.argv.slice(2);
if (root === undefined || operationId === undefined) process.exit(2);

const initial = Object.freeze({
  bindingRevision: "b".repeat(64),
  inventoryRevision: "c".repeat(64),
  phase: "reserved",
  reservationId: "reservation-o004",
  rulesetId: null,
  autoMergeAttempted: false,
  changed: false,
});

class PausingJournalWriter extends AtomicFileStore {
  #paused = false;

  async write(targetPath, content, options = {}) {
    if (targetPath.endsWith(`/${operationId}.json`) && !this.#paused) {
      this.#paused = true;
      process.stdout.write("held\n");
      await new Promise((resolve) => {
        process.stdin.once("data", resolve);
      });
    }
    return super.write(targetPath, content, options);
  }
}

const store = new FileGitHubPolicyOperationStore(root, new PausingJournalWriter());
const result = await store.compareAndSwap({
  operationId,
  expectedRevision: null,
  next: initial,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
await store.close();
process.exit(result.ok ? 0 : 1);
