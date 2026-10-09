import { describe, expect, it } from "vitest";

import {
  LABEL_COLUMN_OVERRIDES,
  resolveTitleFieldColumn,
} from "./shortcode-resolver";

/**
 * `DISPLAY_NAME_COLUMN` names the Drizzle column `lookupEntityLabels` selects
 * as a row's human label: for every entity except the documented
 * `LABEL_COLUMN_OVERRIDES`, it is derived from the storage column behind
 * `presentation.titleField` (`packages/schemas/src/entity-definitions/
 * *.entity.ts`) — see `resolveTitleFieldColumn` and `DISPLAY_NAME_COLUMN`'s
 * construction in `shortcode-resolver.ts`. A non-override entity whose
 * titleField has no derivable column already throws at module init, so this
 * file only checks that the override list stays honest: every override must actually change the outcome, or it is
 * dead documentation nobody would notice going stale.
 */
describe("DISPLAY_NAME_COLUMN", () => {
  // SAFETY: LABEL_COLUMN_OVERRIDES is a fixed object literal, so its own key
  // set is exactly `keyof typeof LABEL_COLUMN_OVERRIDES` — `Object.keys` just
  // can't say so at the type level.
  const overrideEntities = Object.keys(LABEL_COLUMN_OVERRIDES) as Array<
    keyof typeof LABEL_COLUMN_OVERRIDES
  >;

  it.each(overrideEntities)(
    "override for %s is not redundant with the titleField derivation",
    (entity) => {
      const raw = resolveTitleFieldColumn(entity);
      const override = LABEL_COLUMN_OVERRIDES[entity].column;
      // A `null` raw derivation means titleField has no physical column at
      // all — the override is load-bearing regardless of its own value,
      // since without it `DISPLAY_NAME_COLUMN`'s construction throws instead
      // of going quietly to `null`. Only a non-null raw column can make an
      // override redundant, by restating exactly what titleField already
      // gives.
      const redundant = raw !== null && raw === override;
      expect(redundant).toBe(false);
    },
  );
});
