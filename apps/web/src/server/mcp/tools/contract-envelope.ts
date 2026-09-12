import { z } from "zod";

import type { MutationContract, QueryContract } from "~/contracts/define";

/**
 * A `query()`/`mutation()` operation contract member (`~/contracts/define`)
 * declaring an `output` schema. Both `kind`s are accepted structurally, but
 * the union — not a bare `{ output }` shape — is what keeps `fromContract`
 * from also accepting an arbitrary object that merely happens to carry an
 * `output` key.
 */
type ContractOperation<Output extends z.ZodTypeAny> =
  | QueryContract<z.ZodTypeAny, Output>
  | MutationContract<z.ZodTypeAny, Output>;

/**
 * Reads a contract operation's declared output schema BY REFERENCE.
 *
 * The point of building an MCP envelope from `fromContract(op)` instead of
 * importing a `*Out`/`*McpOut` schema straight from `@cubby/schemas` is that
 * the MCP boundary and the transport-neutral operation contract (which also
 * feeds the ts-rest HTTP router and the browser catalog) then validate
 * against the exact same Zod instance. There is one place that can drift:
 * the contract. A second, hand-maintained wrapper schema in
 * `packages/schemas` is exactly the drift this removes.
 */
export function fromContract<Output extends z.ZodTypeAny>(
  op: ContractOperation<Output>,
): Output {
  return op.output;
}

/**
 * `{ items }` — the shape every MCP list tool returns. A bare array root has
 * no JSON Schema `properties` key, and the MCP SDK re-validates
 * `structuredContent` against the declared output schema, so a tool whose
 * root is a plain array fails every call. `items` is taken as-is — usually
 * `fromContract(op)`, already a `z.array(...)` — and is not rebuilt into a
 * fresh array here, so it keeps its identity with the contract's own output
 * schema instance.
 */
export function mcpItemsEnvelope<Items extends z.ZodTypeAny>(items: Items) {
  return z.object({ items });
}

/**
 * `{ results }` — the same envelope shape under a different key, for a tool
 * whose output is keyed `results` rather than `items` (e.g. a batch
 * resolve-or-create response, one result per input name rather than one row
 * per list page).
 */
export function mcpResultsEnvelope<Results extends z.ZodTypeAny>(
  results: Results,
) {
  return z.object({ results });
}
