import type { EntityRef } from "@cubby/schemas/entity";
import { sha256Hex } from "@cubby/shared/sha256";

import type { Database } from "~/server/db";

import { connectionRecord } from "./connection-evidence";

/**
 * The source's own connection-relevant snapshot, the same projection its
 * candidate evidence captures. A candidate's side is fenced by the basis its
 * published Assessment stores and by that endpoint's own discovery, so no
 * corpus-wide revision is read here.
 */
export async function connectionDiscoveryFingerprints(
  db: Database,
  sources: readonly EntityRef[],
): Promise<string[]> {
  const fingerprints: string[] = [];
  // Sequential: a transaction handle runs one statement at a time.
  for (const source of sources) {
    const record = await connectionRecord(db, source);
    fingerprints.push(
      await sha256Hex(
        JSON.stringify([
          "connection-source-v4",
          source.entityKind,
          record.id,
          record.row,
        ]),
      ),
    );
  }
  return fingerprints;
}

export async function connectionDiscoveryFingerprint(
  db: Database,
  source: EntityRef,
) {
  const [fingerprint] = await connectionDiscoveryFingerprints(db, [source]);
  if (!fingerprint) throw new Error("Missing connection input fingerprint");
  return fingerprint;
}
