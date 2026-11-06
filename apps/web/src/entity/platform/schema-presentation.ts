import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const readOverview = createServerFn({ method: "GET" })
  .validator(z.null())
  .handler(async () => {
    const { loadSchemaOverview } =
      await import("~/server/entity-metadata/read.boundary");
    return loadSchemaOverview();
  });

const readOverrides = createServerFn({ method: "GET" })
  .validator(z.null())
  .handler(async () => {
    const { loadSchemaOverrides } =
      await import("~/server/entity-metadata/read.boundary");
    return loadSchemaOverrides();
  });

const readEntity = createServerFn({ method: "GET" })
  .validator(entitySchema)
  .handler(async ({ data }) => {
    const { loadSchemaEntity } =
      await import("~/server/entity-metadata/read.boundary");
    return loadSchemaEntity(data);
  });

/** Schema-derived presentation belongs to this document's QueryClient. No
 * ordinary entity metadata slices or global installed catalog are involved. */
export const schemaOverviewQueryOptions = () =>
  queryOptions({
    queryKey: ["schema-presentation", "overview"],
    queryFn: () => readOverview({ data: null }),
    staleTime: Infinity,
    gcTime: Infinity,
  });

export const schemaOverridesQueryOptions = () =>
  queryOptions({
    queryKey: ["schema-presentation", "overrides"],
    queryFn: () => readOverrides({ data: null }),
    staleTime: Infinity,
    gcTime: Infinity,
  });

export const schemaEntityQueryOptions = (entity: Entity) =>
  queryOptions({
    queryKey: ["schema-presentation", "entity", entity],
    queryFn: () => readEntity({ data: entity }),
    staleTime: Infinity,
    gcTime: Infinity,
  });
