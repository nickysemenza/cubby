import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeLocalWorkerdConfig } from "../../tooling/e2e-worker-config";

import { prepareE2EDatabaseTemplate } from "./e2e-database";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Prepare immutable inputs before Playwright starts isolated worker runtimes. */
async function globalSetup(): Promise<void> {
  const webRoot = path.join(__dirname, "../..");
  writeLocalWorkerdConfig(webRoot);

  console.log("[E2E Setup] Preparing shared PostgreSQL template...");
  const templateStart = performance.now();
  await prepareE2EDatabaseTemplate();
  console.log(
    `[E2E Setup] Shared PostgreSQL template is ready ${Math.round(performance.now() - templateStart)}ms`,
  );
}

export default globalSetup;
