import { eslintCompatPlugin } from "@oxlint/plugins";

import { noUnsafeIdentifiersRule } from "./rules/no-unsafe-identifiers.ts";
import { requireSoftDeleteFilterRule } from "./rules/require-soft-delete-filter.ts";

/** Cubby-specific Oxlint rules ported from one-off `scripts/check-*.ts` gates. */
const cubbyPlugin = eslintCompatPlugin({
  meta: { name: "cubby" },
  rules: {
    "no-unsafe-identifiers": noUnsafeIdentifiersRule,
    "require-soft-delete-filter": requireSoftDeleteFilterRule,
  },
});

export default cubbyPlugin;
