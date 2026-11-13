import { createLogger } from "@cubby/worker-tracing";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import {
  isDerivedSink,
  type DerivedComputes,
} from "~/server/generic/derived/repo/compute";
import {
  beginRebuildPage,
  claimRebuild,
  commitRebuildPage,
  publishRebuiltValues,
  rebuildDeclarations,
  rebuildActive,
  releaseRebuild,
} from "~/server/generic/derived/repo/rebuild";
import { classifyJobFailure } from "~/server/generic/jobs/failure";

const log = createLogger("derived-rebuild");

/** Pages committed by one permit. The 120s lease is renewed with each page. */
const REBUILD_PAGE_BUDGET_MS = 20_000;

/**
 * A dropped connection before a page commits retries the same cursor.
 * The release keeps the cursor-attempt streak and records the error, so page
 * shrinking and the single-record skip still bound a repeated drop, and it
 * does not increment failures. A committed page failure still records its own
 * error and counts.
 */
async function releaseRecordedRebuild(
  db: Database,
  token: string,
  error: unknown,
): Promise<void> {
  const transient = classifyJobFailure(error).kind === "transient";
  await releaseRebuild(
    db,
    token,
    scrubErrorMessage(JSON.stringify(describeErrorCauses(error))),
    { countFailure: !transient },
  );
}

/** A transport retry must outlive the single-writer lease after an isolate is terminated. */
export class DerivedRebuildBusyError extends Error {
  constructor() {
    super("Derived rebuild invocation is already active");
  }
}

/**
 * Several pages of the pass per call, bounded by a wall budget. Each page
 * still commits its cursor before the next one starts. True while the pass
 * has more to do. Continuations carry no entity IDs or work ownership.
 */
export async function rebuildDerived(
  db: Database,
  computes: DerivedComputes,
  { force = false }: { force?: boolean } = {},
): Promise<boolean> {
  const claim = await claimRebuild(db, force);
  if (!claim) {
    if (await rebuildActive(db)) throw new DerivedRebuildBusyError();
    return false;
  }
  log.info("pass invocation started", { target: claim.target });
  const declarations = rebuildDeclarations();
  let current = { target: claim.target, afterId: claim.afterId };
  const started = Date.now();

  try {
    // A missing declaration resets the cursor first. Further pages run until
    // the wall budget, and each committed page renews the lease.
    for (let page = 0; ; page++) {
      const index = declarations.findIndex(
        (entry) => entry.target === current.target,
      );
      const declaration = declarations[index];
      if (!declaration) {
        const first = declarations[0];
        if (!first)
          throw new Error("No deterministic rebuild declarations remain");
        const next = { target: first.target, afterId: null };
        if (!(await commitRebuildPage(db, claim, next, async () => {})))
          return false;
        current = next;
        continue;
      }
      const following = declarations[index + 1];
      const followingTarget = following
        ? { target: following.target, afterId: null }
        : null;
      let next: { target: string; afterId: string | null } | null =
        followingTarget;
      let processedRecords = 0;
      try {
        const compute = computes[declaration.compute];
        if (!compute)
          throw new Error(`Rebuild compute missing: ${declaration.compute}`);
        // At most 50 records per page bounds the page's prepared values.
        const configured = Math.min(
          50,
          Math.max(1, compute.preparationBatchSize ?? 20),
        );
        let observed: Awaited<ReturnType<typeof beginRebuildPage>>;
        try {
          observed = await beginRebuildPage(
            db,
            claim.token,
            declaration,
            current.afterId,
            configured,
            page === 0,
          );
        } catch (error) {
          // Enumeration observed no population: retry the unchanged cursor.
          await releaseRecordedRebuild(db, claim.token, error);
          return true;
        }
        if (!observed) return false;
        const { ids, attempts, limit } = observed;
        processedRecords = ids.length;
        const lastId = ids.at(-1);
        next =
          ids.length === limit && lastId
            ? { target: declaration.target, afterId: lastId }
            : followingTarget;
        if (
          ids.length &&
          attempts > 3 * (Math.floor(Math.log2(configured)) + 1)
        ) {
          if (
            !(await commitRebuildPage(
              db,
              claim,
              next,
              async () => {},
              `Rebuild skipped one record after repeated isolate termination: ${declaration.target}`,
              processedRecords,
            ))
          )
            return false;
        } else if (isDerivedSink(compute)) {
          const prepared = ids.length
            ? await compute.prepare(db, ids)
            : undefined;
          if (
            !(await commitRebuildPage(
              db,
              claim,
              next,
              async (tx) => {
                if (prepared === undefined) return;
                await compute.publish(tx, ids, prepared);
              },
              undefined,
              processedRecords,
            ))
          )
            return false;
        } else {
          const values = ids.length ? await compute(db, ids) : new Map();
          if (
            !(await commitRebuildPage(
              db,
              claim,
              next,
              (tx) => publishRebuiltValues(tx, declaration, ids, values),
              undefined,
              processedRecords,
            ))
          )
            return false;
        }
      } catch (error) {
        // A dropped connection never published this page: the outer release
        // retries the same cursor, keeps the attempt streak and the error,
        // and does not count a failure. A real page failure still advances
        // and counts.
        if (classifyJobFailure(error).kind === "transient") throw error;
        // Keep this page's prior output; later IDs must not starve behind one bad record.
        // During an outage this deliberately makes one failed call per bounded page.
        if (
          !(await commitRebuildPage(
            db,
            claim,
            next,
            async () => {},
            scrubErrorMessage(JSON.stringify(describeErrorCauses(error))),
            processedRecords,
          ))
        )
          return false;
      }
      if (!next) {
        log.info("pass completed", { target: current.target });
        return false;
      }
      current = next;
      if (Date.now() - started >= REBUILD_PAGE_BUDGET_MS) break;
    }
    await releaseRebuild(db, claim.token);
    log.info("pass invocation yielded", { target: current.target });
    return true;
  } catch (error) {
    await releaseRecordedRebuild(db, claim.token, error);
    throw error;
  }
}
