import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  noAdHocNumberFormatRule,
  noHandParsedCreateInputRule,
  noKernelActionGuardRule,
  noRawConsoleRule,
  noRawTableRule,
  noUnboundedPageSizeRule,
} from "./rules/generic-paths.ts";
import { noErrorToastInHandlerRule } from "./rules/no-error-toast-in-handler.ts";
import { noSwallowedCatchRule } from "./rules/no-swallowed-catch.ts";
import { noUnsafeIdentifiersRule } from "./rules/no-unsafe-identifiers.ts";
import { requireSoftDeleteFilterRule } from "./rules/require-soft-delete-filter.ts";

/** Cubby-specific Oxlint rules ported from one-off `scripts/check-*.ts` gates. */
const cubbyPlugin = eslintCompatPlugin({
  meta: { name: "cubby" },
  rules: {
    "no-ad-hoc-number-format": noAdHocNumberFormatRule,
    "no-error-toast-in-handler": noErrorToastInHandlerRule,
    "no-hand-parsed-create-input": noHandParsedCreateInputRule,
    "no-kernel-action-guard": noKernelActionGuardRule,
    "no-raw-console": noRawConsoleRule,
    "no-raw-table": noRawTableRule,
    "no-unbounded-page-size": noUnboundedPageSizeRule,
    "no-swallowed-catch": noSwallowedCatchRule,
    "no-unsafe-identifiers": noUnsafeIdentifiersRule,
    "require-soft-delete-filter": requireSoftDeleteFilterRule,
  },
});

export default cubbyPlugin;
