import type { Entity } from "@cubby/schemas/entity";
import type { SQL } from "drizzle-orm";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import type { PageFieldReadContexts } from "~/server/generic/derived/repo/read-context";

type ReadPorts = {
  title: () => SQL | undefined;
  fieldReads: (
    db: RepositoryQueryInput,
    codes: readonly string[],
  ) => Promise<PageFieldReadContexts | undefined>;
};
const ports = new Map<Entity, ReadPorts>();

/** Repository declarations publish ports without importing their graph from read compilers. */
export function registerReadPorts(entity: Entity, read: ReadPorts): void {
  ports.set(entity, read);
}

/** Resolved only while serving a request, after repository initialization. */
export function repositoryReadPorts(entity: Entity): ReadPorts | undefined {
  return ports.get(entity);
}
