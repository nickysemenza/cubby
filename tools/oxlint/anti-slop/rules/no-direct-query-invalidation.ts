import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const OPERATION_CACHE_PATH =
  "/apps/web/src/integrations/tanstack-query/operation-cache.ts";

function isInvalidateQueriesCall(node: ESTree.CallExpression): boolean {
  if (node.callee.type !== "MemberExpression") return false;
  if (!node.callee.computed) {
    return (
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "invalidateQueries"
    );
  }
  return (
    node.callee.property.type === "Literal" &&
    node.callee.property.value === "invalidateQueries"
  );
}

function isOperationCache(filename: string): boolean {
  return filename.replaceAll("\\", "/").endsWith(OPERATION_CACHE_PATH);
}

/** Funnel TanStack query invalidation through the operation-tag cache boundary. */
export const noDirectQueryInvalidationRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct TanStack invalidateQueries calls outside the operation-tag cache boundary.",
    },
    messages: {
      directInvalidation:
        "Call `invalidateOperationTags` instead; direct `invalidateQueries` calls bypass operation-descriptor cache tags.",
    },
  },
  create(context) {
    if (isOperationCache(context.filename)) return {};

    return {
      CallExpression(node) {
        if (!isInvalidateQueriesCall(node)) return;
        context.report({ node, messageId: "directInvalidation" });
      },
    };
  },
});
