import type { IntegreSQLClient } from "@devoxa/integresql-client";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { testServiceConfig } from "./test-service-config";
import { templateClient } from "./schema-template";

type Setup = Parameters<IntegreSQLClient["initializeTemplate"]>[1];
const initializer = z.object({
  pid: z.number().int().positive(),
  start: z.string().min(1),
  host: z.string(),
});
type Initializer = z.infer<typeof initializer>;

function startTime(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
function provenDead(owner: Initializer): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
  try {
    const start = startTime(owner.pid);
    return !!start && start !== owner.start;
  } catch {
    return false;
  }
}
function marker(hash: string): string {
  const service = createHash("sha1")
    .update(testServiceConfig().url)
    .digest("hex");
  const directory = join(tmpdir(), "cubby-template-initializers", service);
  mkdirSync(directory, { recursive: true });
  return join(directory, `${hash}.json`);
}
function ownerAt(file: string): Initializer | undefined {
  if (!existsSync(file)) return undefined;
  return initializer.parse(JSON.parse(readFileSync(file, "utf8")));
}
function status(error: unknown): number | undefined {
  return error instanceof Error &&
    "responseStatus" in error &&
    typeof error.responseStatus === "number"
    ? error.responseStatus
    : undefined;
}

/**
 * IntegreSQL elects the initializer. A pending record is evidence, never a lock.
 * A dead initializer permanently redirects its hash to a deterministic successor:
 * simultaneous recoverers may DELETE the abandoned hash, never the new one.
 */
export async function initializeRecoverableTemplate(
  initialHash: string,
  setup: Setup,
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
): Promise<string> {
  const client = templateClient();
  const deadline = Date.now() + timeoutMs;
  let hash = initialHash;
  for (let generation = 0; generation < 8;) {
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for IntegreSQL template ${hash}; initializer is live, unknown, or not finalized`,
      );
    const file = marker(hash);
    const owner = ownerAt(file);
    if (owner) {
      if (!provenDead(owner)) {
        await delay(50);
        continue;
      }
      await client.api.discardTemplate(hash).catch((error: unknown) => {
        if (status(error) !== 404) throw error;
      });
      hash = createHash("sha1")
        .update(hash)
        .update(JSON.stringify(owner))
        .digest("hex");
      generation++;
      continue;
    }
    let response: Awaited<ReturnType<typeof client.api.initializeTemplate>>;
    try {
      response = await client.api.initializeTemplate(hash);
    } catch (error) {
      if (status(error) !== 423) throw error;
      // Close the API-create/record-write gap before assuming an existing
      // template was finalized. Bound GET: IntegreSQL otherwise waits minutes.
      if (ownerAt(file)) continue;
      const ready = await fetch(
        `${testServiceConfig().url}/api/v1/templates/${hash}/tests`,
        {
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(1000, deadline - Date.now())),
          ),
        },
      ).catch((error: unknown) => {
        if (
          error instanceof Error &&
          ["TimeoutError", "AbortError"].includes(error.name)
        )
          return undefined;
        throw error;
      });
      if (ready?.ok) {
        const lease = z.object({ id: z.number() }).parse(await ready.json());
        await client.api.reuseTestDatabase(hash, lease.id);
        return hash;
      }
      if (ready && ![404, 410, 500, 503].includes(ready.status))
        throw new Error(
          `IntegreSQL readiness ${ready.status}: ${await ready.text()}`,
          { cause: error },
        );
      await delay(50);
      continue;
    }
    // A delayed POST can arrive after another waiter discarded a dead owner.
    // Preserve that redirect rather than reclaiming the abandoned generation.
    if (ownerAt(file)) continue;
    const identity = {
      pid: process.pid,
      start: startTime(process.pid),
      host: hostname(),
    };
    initializer.parse(identity);
    const pending = `${file}.${process.pid}.tmp`;
    writeFileSync(pending, JSON.stringify(identity));
    renameSync(pending, file);
    try {
      await setup(response.database.config);
      await client.api.finalizeTemplate(hash);
      rmSync(file);
      return hash;
    } catch (error) {
      try {
        await client.api.discardTemplate(hash);
        rmSync(file, { force: true });
      } catch (discardError) {
        throw new AggregateError(
          [error, discardError],
          `Template ${hash} initialization and discard failed`,
          { cause: discardError },
        );
      }
      throw error;
    }
  }
  throw new Error(
    `Too many interrupted IntegreSQL template generations for ${initialHash}`,
  );
}
