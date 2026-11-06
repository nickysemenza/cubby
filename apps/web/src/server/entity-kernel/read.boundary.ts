import type { Entity } from "@cubby/schemas/entity";
import type { SQL } from "drizzle-orm";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import type { PageFieldReadContexts } from "~/server/generic/derived/repo/read-context";

/** Declaration boundary: repository compilers do not follow the domain loader graph. */
export async function repositoryReadBinding(entity: Entity): Promise<{
  title: () => SQL | undefined | Promise<SQL | undefined>;
  fieldReads: (
    db: RepositoryQueryInput,
    codes: readonly string[],
  ) => Promise<PageFieldReadContexts>;
}> {
  const bindings =
    await import("~/server/generated/entity-kernel-bindings.gen");
  return bindings.repositoryReadBinding(entity);
}
