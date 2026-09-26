import { z } from "zod";

import {
  childSchemas,
  discriminatorOf,
  wireProjection,
  wireRegistry,
} from "../../../apps/web/src/lib/http-api/wire.ts";

/**
 * `schemaTransformer` in `openapi.ts` only registers the ROUTE-LEVEL schema
 * it was asked to convert, so a discriminated union nested inside a route's
 * input/output never gets its members added to the io's `z.registry` — they
 * still carry an id, but `z.toJSONSchema` only extracts a schema into its
 * own component when that schema's id is visible through
 * `ctx.metadataRegistry` (`z.globalRegistry` by default) OR the schema is
 * itself an entry of the registry being converted. Recursing from every
 * named export's wire projection and registering any discriminated union's
 * members closes that gap. `run.startTargeted`
 * (`packages/schemas/src/run.ts`'s `targetedImportStartInput`) is the first
 * discriminated union to reach HTTP, so nothing exercised this path before.
 *
 * `toWire` rebuilds every object/union node (`wire.ts`'s `rebuild`), so a
 * union's WIRE-projected members are different object instances than its raw
 * ones — and `remember` only copies a raw member's plain `.meta({ id })`
 * across into `wireRegistry` on the wire clone when the id survives
 * unprefixed for a request/response TWIN (a schema whose input and output
 * shapes differ); otherwise the wire clone's own `wireRegistry` id carries an
 * `${io}_` prefix meant to disambiguate that twin, not to rename an
 * otherwise unambiguous member. Every other named-export component in this
 * document keeps its bare PascalCase name (`openapi-document.unit.test.ts`'s
 * "names components after their exports"), so this walks the RAW and WIRE
 * trees in lockstep — same `childSchemas` order, since a union's wire
 * projection maps `options` 1:1 — and prefers the raw member's own bare id.
 */
function registerDiscriminatedUnionMembers(
  registry: z.core.$ZodRegistry<{ id: string }>,
  rawSchema: z.ZodType,
  wireSchema: z.ZodType,
  seen: Set<z.ZodType>,
): void {
  if (seen.has(wireSchema)) return;
  seen.add(wireSchema);
  const rawChildren = childSchemas(rawSchema);
  const wireChildren = childSchemas(wireSchema);
  const isUnion = discriminatorOf(wireSchema) !== undefined;
  for (const [index, [, wireChild]] of wireChildren.entries()) {
    const rawChild = rawChildren[index]?.[1] ?? wireChild;
    if (isUnion) {
      const id =
        z.globalRegistry.get(rawChild)?.id ??
        wireRegistry.get(wireChild)?.id ??
        z.globalRegistry.get(wireChild)?.id;
      if (!registry.has(wireChild) && id !== undefined)
        registry.add(wireChild, { id });
    }
    registerDiscriminatedUnionMembers(registry, rawChild, wireChild, seen);
  }
}

/**
 * Walks every named export's wire projection on this `io` side and registers
 * any discriminated union member it finds that is missing from `registry`.
 * Call once per `io` (input/output), after `z.toJSONSchema`'s inputs are
 * otherwise settled, and before converting `registry` to JSON Schema.
 */
export function registerDiscriminatedUnionMembersForIo(
  registry: z.core.$ZodRegistry<{ id: string }>,
  io: "input" | "output",
  namedDomains: Iterable<z.ZodType>,
): void {
  const seen = new Set<z.ZodType>();
  for (const domain of namedDomains) {
    const projected = wireProjection(domain, io);
    if (projected !== undefined)
      registerDiscriminatedUnionMembers(registry, domain, projected, seen);
  }
}
