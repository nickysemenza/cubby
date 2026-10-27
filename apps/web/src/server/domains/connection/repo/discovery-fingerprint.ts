import type { EntityRef } from "@cubby/schemas/entity";
import { sha256Hex } from "@cubby/shared/sha256";

import type { Database } from "~/server/db";

import {
  connectionRecord,
  connectionRecordKey,
  connectionRecords,
} from "./connection-evidence";

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
  const fingerprints = await connectionDiscoveryFingerprintsOrMissing(
    db,
    sources,
  );
  return fingerprints.map((fingerprint, index) => {
    if (fingerprint === null)
      throw new Error(
        `Connection ${sources[index]!.entityKind} no longer exists`,
      );
    return fingerprint;
  });
}

/** One read per entity kind; a deleted or merged source reads `null`. */
export async function connectionDiscoveryFingerprintsOrMissing(
  db: Database,
  sources: readonly EntityRef[],
): Promise<(string | null)[]> {
  const records = await connectionRecords(db, sources);
  return Promise.all(
    sources.map((source) => {
      const record = records.get(connectionRecordKey(source));
      return record ? fingerprintRecord(source, record) : null;
    }),
  );
}

export async function connectionDiscoveryFingerprint(
  db: Database,
  source: EntityRef,
) {
  return fingerprintRecord(source, await connectionRecord(db, source));
}

function fingerprintRecord(
  source: EntityRef,
  record: Awaited<ReturnType<typeof connectionRecord>>,
) {
  return sha256Hex(
    JSON.stringify([
      "connection-source-v4",
      source.entityKind,
      record.id,
      record.row,
    ]),
  );
}
