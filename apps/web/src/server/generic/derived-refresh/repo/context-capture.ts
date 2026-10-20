import type { DerivedRefreshContext } from "@cubby/schemas/derived-refresh";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";

import { captureDerivedRefresh, type RefreshCapture } from "./capture";

/** Child-table writers already know both endpoints; no owner lookup or fanout. */
export async function captureContextRefresh(
  db: RepositoryQueryInput,
  table: DerivedRefreshContext,
  roots: readonly RefreshCapture[],
) {
  await captureDerivedRefresh(db, roots, {
    revisionKeys: [`context:${table}`],
  });
}
