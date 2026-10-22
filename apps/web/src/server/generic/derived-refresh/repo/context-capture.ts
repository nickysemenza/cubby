import type {
  DerivedRefreshCapture,
  DerivedRefreshContext,
} from "@cubby/schemas/derived-refresh";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";

import { captureDerivedRefresh } from "./capture";

/** Child-table writers already know both endpoints; no owner lookup or fanout. */
export async function captureContextRefresh(
  db: RepositoryQueryInput,
  _table: DerivedRefreshContext,
  roots: readonly DerivedRefreshCapture[],
) {
  await captureDerivedRefresh(db, roots, {
    force: true,
  });
}
