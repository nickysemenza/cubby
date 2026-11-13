import type { KernelJson } from "@cubby/schemas/kernel/machinery";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import type { Database } from "~/server/db/database";
import {
  isDerivedSink,
  type DerivedComputes,
} from "~/server/generic/derived/repo/compute";
import {
  recordSnapshotCursor,
  publishSnapshotPage,
  enumerateSnapshotPage,
  publishRebuiltValues,
  rebuildDeclarations,
} from "~/server/generic/derived/repo/rebuild";
import {
  snapshotCursor,
  type SnapshotCursor,
} from "~/server/generic/derived/repo/snapshot-state";
import { classifyJobFailure } from "~/server/generic/jobs/failure";
import type { Claim, PassResult } from "~/server/kernel/api";

const diagnostic = (error: unknown) =>
  scrubErrorMessage(JSON.stringify(describeErrorCauses(error)));

/** One bounded page. Prepared values and the next position commit under the kernel claim together. */
export async function rebuildSnapshotPage(
  db: Database,
  computes: DerivedComputes,
  raw: KernelJson | null,
  claim: Claim,
): Promise<PassResult> {
  const declarations = rebuildDeclarations();
  const cursor = snapshotCursor(raw);
  const knownIndex = declarations.findIndex(
    (entry) => entry.target === cursor.target,
  );
  const index = Math.max(0, knownIndex);
  const declaration = declarations[index];
  if (!declaration) return { cursor, done: true };
  const attempted: SnapshotCursor = {
    ...cursor,
    afterId: knownIndex < 0 ? null : cursor.afterId,
    target: declaration.target,
    cursorAttempts: cursor.cursorAttempts + 1,
    startedAt: cursor.startedAt ?? new Date().toISOString(),
    finishedAt: null,
  };
  // Persist before preparation so an isolate death still shrinks its next page.
  await recordSnapshotCursor(claim.fenced, attempted);
  const compute = computes[declaration.compute];
  if (!compute)
    throw new Error(`Rebuild compute missing: ${declaration.compute}`);
  const configured = Math.min(
    50,
    Math.max(1, compute.preparationBatchSize ?? 20),
  );
  const limit = Math.max(
    1,
    Math.floor(
      configured / 2 ** Math.floor((attempted.cursorAttempts - 1) / 3),
    ),
  );
  const ids = await enumerateSnapshotPage(
    db,
    declaration,
    attempted.afterId,
    limit,
  );
  const last = ids.at(-1);
  const following = declarations[index + 1];
  const next =
    ids.length === limit && last
      ? { target: declaration.target, afterId: last }
      : following
        ? { target: following.target, afterId: null }
        : null;
  const advanced = (problem?: string): SnapshotCursor => {
    const now = new Date().toISOString();
    const failures = attempted.passFailures + (problem ? 1 : 0);
    const result: SnapshotCursor = {
      ...attempted,
      target: next?.target ?? null,
      afterId: next?.afterId ?? null,
      cursorAttempts: 0,
      pages: attempted.pages + 1,
      processedRecords: attempted.processedRecords + ids.length,
      failedPages: attempted.failedPages + (problem ? 1 : 0),
      passFailures: failures,
      failures: !next && !failures ? 0 : attempted.failures + (problem ? 1 : 0),
      error: problem
        ? `${problem}${attempted.error ? `: ${attempted.error}` : ""}`
        : !next && !failures
          ? null
          : attempted.error,
      lastMovementAt: now,
      cleanAt: !next && !failures ? now : attempted.cleanAt,
    };
    if (!next) {
      result.finishedAt = now;
      const durationMs = Math.max(
        0,
        Date.now() - new Date(result.startedAt ?? now).getTime(),
      );
      result.durationsMs = [...result.durationsMs, durationMs].slice(-3);
      result.history = [
        ...result.history,
        {
          startedAt: result.startedAt ?? now,
          finishedAt: now,
          durationMs,
          pages: result.pages,
          processedRecords: result.processedRecords,
          failedPages: result.failedPages,
        },
      ].slice(-3);
    }
    return result;
  };
  let publish: (tx: Database) => Promise<void> = async () => {};
  let problem: string | undefined;
  try {
    if (
      ids.length &&
      attempted.cursorAttempts > 3 * (Math.floor(Math.log2(configured)) + 1)
    )
      problem = `Rebuild skipped one record after repeated isolate termination: ${declaration.target}`;
    else if (isDerivedSink(compute)) {
      const prepared = ids.length ? await compute.prepare(db, ids) : undefined;
      if (prepared !== undefined)
        publish = (tx) => compute.publish(tx, ids, prepared);
    } else {
      const values = ids.length ? await compute(db, ids) : new Map();
      publish = (tx) => publishRebuiltValues(tx, declaration, ids, values);
    }
  } catch (error) {
    if (classifyJobFailure(error).kind === "transient") {
      await recordSnapshotCursor(claim.fenced, {
        ...attempted,
        error: diagnostic(error),
      });
      throw error;
    }
    problem = diagnostic(error);
  }
  const output = advanced(problem);
  return {
    cursor: output,
    done: next === null,
    async publish(tx) {
      if (problem) return;
      try {
        // A failed sink rolls back its page and effects; later populations still progress.
        await publishSnapshotPage(tx, publish);
      } catch (error) {
        if (classifyJobFailure(error).kind === "transient") throw error;
        Object.assign(output, advanced(diagnostic(error)));
      }
    },
  };
}
