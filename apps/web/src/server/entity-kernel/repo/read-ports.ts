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

/** Scaffolds publish ports without importing the repository graph from read compilers. */
export function registerReadPorts(entity: Entity, read: ReadPorts): void {
  ports.set(entity, read);
}

/** A domain's read ports exist as soon as its scaffold has initialized. */
export function repositoryReadPorts(entity: Entity): ReadPorts | undefined {
  return ports.get(entity);
}
