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
  rebuildIds,
  releaseRebuild,
} from "~/server/generic/derived/repo/rebuild";

const log = createLogger("derived-rebuild");

/** A transport retry must outlive the single-writer lease after an isolate is terminated. */
export class DerivedRebuildBusyError extends Error {
  constructor() {
    super("Derived rebuild invocation is already active");
  }
}

/** A bounded Worker invocation. Continuations carry no entity IDs or work ownership. */
export async function rebuildDerived(
  db: Database,
  computes: DerivedComputes,
  {
    force = false,
    pageLimit = Number.POSITIVE_INFINITY,
    deadline = Date.now() + 20_000,
  }: { force?: boolean; pageLimit?: number; deadline?: number } = {},
): Promise<boolean> {
  const claim = await claimRebuild(db, force);
  if (!claim) {
    if (await rebuildActive(db)) throw new DerivedRebuildBusyError();
    return false;
  }
  log.info("pass invocation started", { target: claim.target });
  const declarations = rebuildDeclarations();
  let current = { target: claim.target, afterId: claim.afterId };

  try {
    for (let page = 0; page < pageLimit; page++) {
      const attempts =
        page === 0
          ? claim.cursorAttempts
          : await beginRebuildPage(db, claim.token);
      if (attempts === null) return false;
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
      try {
        const compute = computes[declaration.compute];
        if (!compute)
          throw new Error(`Rebuild compute missing: ${declaration.compute}`);
        const configured = Math.min(
          200,
          Math.max(1, compute.preparationBatchSize ?? 20),
        );
        // Counts are committed before compute, so CPU/memory termination also shrinks the retry.
        const limit = Math.max(
          1,
          Math.floor(configured / 2 ** Math.floor((attempts - 1) / 3)),
        );
        const ids = await rebuildIds(db, declaration, current.afterId, limit);
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
            ))
          )
            return false;
        } else if (isDerivedSink(compute)) {
          const prepared = ids.length
            ? await compute.prepare(db, ids)
            : undefined;
          const failures =
            prepared === undefined
              ? undefined
              : compute.preparationFailures?.(prepared);
          if (failures?.size)
            throw new AggregateError(
              [...failures.values()],
              `Rebuild preparation failed: ${declaration.target}`,
            );
          if (
            !(await commitRebuildPage(db, claim, next, async (tx) => {
              if (prepared === undefined) return;
              const outcome = await compute.publish(tx, ids, prepared, {
                tickets: new Map(),
                notify: () => {},
              });
              if (
                !Array.isArray(outcome) &&
                "retain" in outcome &&
                outcome.retain.length
              )
                throw new Error(
                  `Rebuild sink retained output: ${declaration.target}`,
                );
            }))
          )
            return false;
        } else {
          const values = ids.length ? await compute(db, ids) : new Map();
          if (
            !(await commitRebuildPage(db, claim, next, (tx) =>
              publishRebuiltValues(tx, declaration, ids, values),
            ))
          )
            return false;
        }
      } catch (error) {
        // Keep this page's prior output; later IDs must not starve behind one bad record.
        // During an outage this deliberately makes one failed call per bounded page.
        if (
          !(await commitRebuildPage(
            db,
            claim,
            next,
            async () => {},
            scrubErrorMessage(JSON.stringify(describeErrorCauses(error))),
          ))
        )
          return false;
      }
      if (!next) {
        log.info("pass completed", { target: current.target });
        return false;
      }
      current = next;
      if (Date.now() >= deadline) break;
    }
    await releaseRebuild(db, claim.token);
    log.info("pass invocation yielded", { target: current.target });
    return true;
  } catch (error) {
    await releaseRebuild(
      db,
      claim.token,
      scrubErrorMessage(JSON.stringify(describeErrorCauses(error))),
    );
    throw error;
  }
}
