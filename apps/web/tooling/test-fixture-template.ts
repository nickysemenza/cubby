import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import type { TestProject } from "vitest/node";
import { processStatus } from "./dev-services/process-identity.ts";
import { worktreeRoot } from "./dev-services/harness-lock.ts";
import {
  cloneSchemaTemplate,
  templateClient,
  templateConnectionUrl,
} from "./schema-template";
import { hashSchemaTemplateInputs } from "./schema-template-inputs";
import { initializeRecoverableTemplate } from "./template-recovery";

/**
 * Per-run IntegreSQL templates for expensive per-test fixtures.
 *
 * A file opts in with `ctx.fixture(key, seed)`: the first caller in the run
 * seeds an IntegreSQL template once, and every test that asks for the same key
 * gets its own fresh clone, so each test still starts from an identical
 * database. Clones cost ~25 ms idle and ~240 ms p50 with four workers cloning
 * at once, against ~21 ms for the default DELETE reset, so a fixture pays only
 * when its seed costs more than a few hundred milliseconds.
 *
 * Templates are keyed by run, not by content: a seed reads arbitrary
 * application code, and a stale cross-run template would silently test old
 * behavior. The run's `globalSetup` discards its templates, and the next run
 * discards any left by a run that died.
 */

declare module "vitest" {
  export interface ProvidedContext {
    cubbyFixtureRun: string;
  }
}

const runRoot = join(tmpdir(), "cubby-test-fixtures");

function runDirectory(run: string): string {
  return join(runRoot, run);
}

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Discard a run's templates. A hash whose discard fails keeps its entry, so
 * the next dead-run sweep retries it; IntegreSQL 404 means it is already gone.
 * Another worktree's sweep may collect the same dead run concurrently.
 */
async function discardRun(directory: string): Promise<void> {
  let hashes: string[];
  try {
    hashes = readdirSync(directory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const client = templateClient();
  const failures: string[] = [];
  for (const hash of hashes) {
    try {
      await client.api.discardTemplate(hash);
    } catch (error) {
      const status =
        error instanceof Error && "responseStatus" in error
          ? error.responseStatus
          : undefined;
      if (status !== 404) {
        failures.push(
          `${hash}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }
    rmSync(join(directory, hash), { force: true });
  }
  if (failures.length) {
    // Cleanup must not fail a finished run; the entries stay for a retry.
    console.warn(
      `[test fixtures] Could not discard ${failures.length} IntegreSQL fixture template(s); the next run retries them:\n${failures.join("\n")}`,
    );
    return;
  }
  rmSync(directory, { recursive: true, force: true });
}

/** `globalSetup`: name this run and collect templates from dead runs. */
export async function setupFixtureRun(project: TestProject): Promise<string> {
  mkdirSync(runRoot, { recursive: true });
  for (const entry of readdirSync(runRoot)) {
    const pid = Number(entry.split("-")[0]);
    if (Number.isSafeInteger(pid) && processStatus(pid, undefined) === "dead")
      await discardRun(join(runRoot, entry));
  }
  const run = `${process.pid}-${randomUUID()}`;
  mkdirSync(runDirectory(run));
  project.provide("cubbyFixtureRun", run);
  return run;
}

/** `globalSetup` teardown: discard every template this run seeded. */
export async function teardownFixtureRun(run: string): Promise<void> {
  const directory = runDirectory(run);
  if (existsSync(directory)) await discardRun(directory);
}

const prepared = new Map<string, Promise<string>>();

/**
 * The IntegreSQL hash of `key`'s seeded template, initializing it on first use.
 * `seed` receives the template's connection URL after the migrated schema has
 * been cloned into it.
 */
export function prepareFixtureTemplate(
  key: string,
  seed: (databaseUrl: string) => Promise<void>,
): Promise<string> {
  let ready = prepared.get(key);
  if (!ready) {
    const run = inject("cubbyFixtureRun");
    const hash = createHash("sha1")
      .update(hashSchemaTemplateInputs())
      .update("\0fixture\0")
      .update(worktreeRoot)
      .update("\0")
      .update(run)
      .update("\0")
      .update(key)
      .digest("hex");
    writeFileSync(join(runDirectory(run), hash), key);
    ready = initializeRecoverableTemplate(hash, async (config) => {
      await cloneSchemaTemplate(config.database);
      await seed(templateConnectionUrl(config));
    });
    // A failed seed must not poison later callers with the same rejection.
    ready.catch(() => prepared.delete(key));
    prepared.set(key, ready);
  }
  return ready;
}
