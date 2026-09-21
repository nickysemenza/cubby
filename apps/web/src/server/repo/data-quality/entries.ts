import type { ScoredEntity } from "@cubby/schemas/data-quality";

import { productChecks } from "./checks/product";
import { purchaseChecks } from "./checks/purchase";
import type { EntityChecks, ScoredTable } from "./registry";

/** The registry's owner contract: one entry per scored entity. */
export type DataQualityEntries = {
  readonly [E in ScoredEntity]: EntityChecks<E, ScoredTable>;
};

/**
 * Every scored entity's SQL bindings, keyed by entity. `satisfies` is the
 * gate: a manifest that declares `capabilities.dataQuality` for an entity
 * with no entry here — or an entry missing one of the entity's generated
 * check ids — fails typecheck. Exported with its inferred (per-table) type so
 * a roll-up can `alias()` a related table without losing its columns.
 */
export const dataQualityEntries = {
  product: productChecks,
  purchase: purchaseChecks,
} satisfies DataQualityEntries;
