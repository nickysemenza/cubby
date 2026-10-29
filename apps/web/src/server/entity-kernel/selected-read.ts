import { z } from "zod";

import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";
import { kernelScaffold } from "~/server/entity-kernel/scaffolds";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";
import {
  publicFieldEnvelopeRows,
  selectedFieldEnvelopeSchema,
} from "~/server/generic/derived/repo/public-read";

const selectedEntityRecord = z.record(z.string(), z.unknown());

/** Internal consumers retain canonical detail envelopes without loading unrelated fields. */
export async function readSelectedEntityRecords({
  context,
  entity,
  ids,
  fields,
}: {
  context: Pick<EntityKernelContext, "db" | "actorContext">;
  entity: EntityKernelEntity;
  ids: readonly string[];
  fields: readonly string[];
}): Promise<z.output<typeof selectedEntityRecord>[]> {
  const scaffold = kernelScaffold(entity);
  if (!scaffold)
    throw new Error(`Missing selected read scaffold for ${entity}`);
  const binding = ENTITY_SCHEMA_BINDINGS[entity];
  const schema = selectedFieldEnvelopeSchema(binding.detail, fields);
  // Input-only context keys remain absent, as they are in a complete public read.
  const projection = [
    ...Object.keys(schema.shape).filter((key) => key !== "fields"),
    ...Object.keys(schema.shape.fields.shape),
    // Resolver evidence supplies effective values and provenance before serialization.
    ...(scaffold.fields.detail.includes("fieldResolutions")
      ? ["fieldResolutions"]
      : []),
  ];
  const found = await scaffold.get(
    context.db,
    ids.map((id) => binding.id.parse(id)),
    projection,
    {
      actor: context.actorContext,
    },
  );
  const rows = await publicFieldEnvelopeRows({
    db: context.db,
    entity,
    schema,
    rows: found.data,
    contexts: found.fieldReads,
  });
  return rows.map((row) => selectedEntityRecord.parse(row));
}
