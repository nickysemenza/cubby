import type {
  DerivedRefreshCapture,
  DerivedRefreshContext,
} from "@cubby/schemas/derived-refresh";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";

import { captureDerivedRefresh } from "./capture";
import { captureContextRefresh } from "./context-capture";

export async function recordDerivedRefreshRoots(
  db: RepositoryQueryInput,
  roots: readonly DerivedRefreshCapture[],
): Promise<void> {
  await captureDerivedRefresh(db, roots);
}

/** Schema-free repositories register known endpoints through this checked contract. */
export async function recordContextRefresh(
  db: RepositoryQueryInput,
  table: DerivedRefreshContext,
  roots: readonly DerivedRefreshCapture[],
): Promise<void> {
  await captureContextRefresh(db, table, roots);
}
