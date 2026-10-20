import { sweepRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";

import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { derivedDiscoveryPass, run } from "~/server/db/schema";
import {
  connectionInputFamilies,
  connectionInputKeys,
} from "~/server/domains/connection/repo/discovery-inputs";
import {
  hasAiRefreshRunCapacity,
  tryLockAiRefreshScheduling,
} from "~/server/domains/run/repo/ai-refresh-admission";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import { activeSweepFor } from "~/server/domains/run/repo/run-step";
import { hasUnmaterializedInputs } from "~/server/generic/derived-refresh/repo/freshness";
import { readInputRevisions } from "~/server/generic/derived-refresh/repo/revisions";

import { ensureRun } from "./ensure-run";

/** One active Sweep freezes its epochs; edits during it are the next pass. */
export async function claimDerivedDiscovery(db: Database) {
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled || !activation.manifest["entity-connections"])
    return;
  return withTransactionDatabase(db, async (tx) => {
    if (!(await tryLockAiRefreshScheduling(tx))) return;
    const states = await getDb(tx).select().from(derivedDiscoveryPass);
    for (const state of states) {
      if (!state.runId) continue;
      const [owner] = await getDb(tx)
        .select({ status: run.status })
        .from(run)
        .where(eq(run.id, state.runId))
        .limit(1);
      if (owner?.status === "completed")
        await getDb(tx)
          .update(derivedDiscoveryPass)
          .set({ coveredFingerprint: state.fingerprint, runId: null })
          .where(eq(derivedDiscoveryPass.family, state.family));
      // Exhausted, cancelled and paused passes keep their owner and retry history.
    }
    if (
      (await activeSweepFor(tx, "recommendation")) ||
      !(await hasAiRefreshRunCapacity(tx))
    )
      return;
    const ready: { kind: string; fingerprint: string }[] = [];
    for (const kind of connectionInputFamilies()) {
      const state = states.find((row) => row.family === kind);
      const keys = [`kind:${kind}`, ...connectionInputKeys(kind)];
      const kinds = keys
        .filter((key) => key.startsWith("kind:"))
        .map((key) => key.slice(5));
      if (await hasUnmaterializedInputs(tx, kinds, { pendingOnly: true }))
        continue;
      const projection = keys
        .filter((key) => key.startsWith("kind:"))
        .map((key) => key.replace("kind:", "projection:"));
      const embedding = keys
        .filter((key) => key.startsWith("kind:"))
        .map((key) => key.replace("kind:", "embedding:"));
      const fingerprint = await sha256Hex(
        JSON.stringify([
          "discovery-pass-v3",
          await readInputRevisions(tx, [...keys, ...projection, ...embedding]),
        ]),
      );
      if (state?.runId) {
        const [owner] = await getDb(tx)
          .select({ status: run.status })
          .from(run)
          .where(eq(run.id, state.runId))
          .limit(1);
        if (owner?.status !== "completed" && fingerprint === state.fingerprint)
          continue;
        if (
          owner &&
          ["running", "paused", "paused_auth"].includes(owner.status)
        )
          continue;
      }
      const covered = state?.runId
        ? state.fingerprint
        : state?.coveredFingerprint;
      if (fingerprint !== covered) ready.push({ kind, fingerprint });
    }
    if (ready.length === 0) return;
    const runId = await ensureRun(tx, systemActor(), {
      purpose: "sweep",
      trigger: "scheduled",
      status: "running",
      input: sweepRunInput.parse({
        kind: "sweep",
        families: [
          {
            family: "recommendation",
            scope: { entityKinds: ready.map((entry) => entry.kind) },
          },
        ],
      }),
    });
    await getDb(tx)
      .insert(derivedDiscoveryPass)
      .values(
        ready.map((entry) => ({
          family: entry.kind,
          fingerprint: entry.fingerprint,
          runId,
        })),
      )
      .onConflictDoUpdate({
        target: derivedDiscoveryPass.family,
        set: {
          fingerprint: sql`excluded.fingerprint`,
          runId: sql`excluded."runId"`,
        },
      });
    return runId;
  });
}

import { sql } from "drizzle-orm";
