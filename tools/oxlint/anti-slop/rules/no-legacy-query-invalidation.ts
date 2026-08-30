import { defineRule } from "@oxlint/plugins";

const LEGACY_INVALIDATION_IDENTIFIERS = new Set([
  "cancelQueryRoots",
  "invalidatesFor",
  "invalidateQueryRoots",
  "normalizeQueryRoot",
  "queryKeys",
]);

/** Keep the removed query-key invalidation API from quietly returning. */
export const noLegacyQueryInvalidationRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the removed query-key invalidation API; operation descriptors own cache tags.",
    },
    messages: {
      legacyInvalidation:
        "`{{name}}` belongs to the removed query-key invalidation API. Declare cache tags on the operation descriptor instead.",
    },
  },
  createOnce(context) {
    return {
      Identifier(node) {
        if (!LEGACY_INVALIDATION_IDENTIFIERS.has(node.name)) return;
        context.report({
          node,
          messageId: "legacyInvalidation",
          data: { name: node.name },
        });
      },
    };
  },
});
