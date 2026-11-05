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
  claimRebuild,
  commitRebuildPage,
  publishRebuiltValues,
  rebuildDeclarations,
  rebuildActive,
  rebuildIds,
  releaseRebuild,
} from "~/server/generic/derived/repo/rebuild";

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
    pageLimit = 5,
  }: { force?: boolean; pageLimit?: number } = {},
): Promise<boolean> {
  const claim = await claimRebuild(db, force);
  if (!claim) {
    if (await rebuildActive(db)) throw new DerivedRebuildBusyError();
    return false;
  }
  const declarations = rebuildDeclarations();
  let current = { target: claim.target, afterId: claim.afterId };
  const started = Date.now();
  try {
    for (let page = 0; page < pageLimit; page++) {
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
      const compute = computes[declaration.compute];
      if (!compute)
        throw new Error(`Rebuild compute missing: ${declaration.compute}`);
      const limit = Math.min(
        200,
        Math.max(1, compute.preparationBatchSize ?? 20),
      );
      const ids = await rebuildIds(db, declaration, current.afterId, limit);
      const following = declarations[index + 1];
      const lastId = ids.at(-1);
      const next =
        ids.length === limit && lastId
          ? { target: declaration.target, afterId: lastId }
          : following
            ? { target: following.target, afterId: null }
            : null;
      if (isDerivedSink(compute)) {
        const prepared = ids.length
          ? await compute.prepare(db, ids)
          : undefined;
        if (
          prepared !== undefined &&
          compute.preparationFailures?.(prepared).size
        )
          throw new Error(`Rebuild preparation failed: ${declaration.target}`);
        if (
          !(await commitRebuildPage(db, claim, next, async (tx) => {
            if (prepared !== undefined) {
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
            }
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
      if (!next) return false;
      current = next;
      if (Date.now() - started >= 20_000) break;
    }
    await releaseRebuild(db, claim.token);
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

/** Manual rebuilds use the same pass and never reset an active cursor. */
export async function requestDerivedRebuild(db: Database) {
  const existing = await rebuildActive(db);
  const claim = await claimRebuild(db, true);
  if (claim) await releaseRebuild(db, claim.token);
  return { existing: existing || claim === null };
}
