import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Enforcement layer for the "error surfaces stay raw" product rule (see
 * AGENTS.md "Product constraints"): `showErrorToast` (`apps/web/src/components/feedback/error-details.tsx`)
 * is the only toast path that keeps the raw server message and attaches the
 * Details action; a hand-rolled `toast.error(...)` written where an error
 * object is already in scope re-derives a worse message and drops
 * diagnostics. This rule flags `toast.error(...)` only inside the three
 * shapes that put an error in scope — a `catch` clause, a `.catch(cb)`
 * callback, or an `onError` handler — and leaves every other `toast.error`
 * call (validation notices, copy failures, etc.) alone.
 *
 * `apps/web/src/components/feedback/error-details.tsx` itself calls
 * `toast.error` as part of implementing the shared helper; it is excluded
 * via the `.oxlintrc.json` override, not here, so the exclusion is visible
 * next to the other file-glob overrides instead of hidden in the rule.
 */

const MESSAGE =
  "An error object is in scope here — use showErrorToast(error, message?) from ~/components/feedback/error-details so the raw message and Details action are kept.";

function isToastErrorCall(node: ESTree.CallExpression): boolean {
  const { callee } = node;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "toast" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "error"
  );
}

function isCatchCallbackFunction(node: ESTree.Node): boolean {
  if (
    node.type !== "ArrowFunctionExpression" &&
    node.type !== "FunctionExpression"
  )
    return false;
  const { parent } = node;
  if (parent.type !== "CallExpression") return false;
  const { callee } = parent;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== "catch"
  )
    return false;
  return parent.arguments.some((argument) => argument === node);
}

function isOnErrorPropertyValue(node: ESTree.Node): boolean {
  if (
    node.type !== "ArrowFunctionExpression" &&
    node.type !== "FunctionExpression"
  )
    return false;
  const { parent } = node;
  if (parent.type !== "Property" || parent.computed || parent.value !== node)
    return false;
  const { key } = parent;
  if (key.type === "Identifier") return key.name === "onError";
  // `key.value` covers every Literal kind (string/number/boolean/…); a
  // non-string value just compares unequal, so no `typeof` narrowing needed.
  return key.type === "Literal" && key.value === "onError";
}

/** Walk every ancestor (not just the immediate parent) — the call can sit
 * several statements deep inside the catch/handler body. */
function isInErrorHandlingContext(node: ESTree.CallExpression): boolean {
  let current: ESTree.Node = node.parent;
  while (current.type !== "Program") {
    if (current.type === "CatchClause") return true;
    if (isCatchCallbackFunction(current)) return true;
    if (isOnErrorPropertyValue(current)) return true;
    current = current.parent;
  }
  return false;
}

/** Cubby's "raw error toast" gate: `toast.error` written where an error
 * object is already in scope, instead of `showErrorToast`. */
export const noErrorToastInHandlerRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow toast.error(...) inside a catch clause, .catch() callback, or onError handler in favor of showErrorToast.",
    },
    messages: {
      toastErrorInHandler: MESSAGE,
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (!isToastErrorCall(node)) return;
        if (isInErrorHandlingContext(node))
          context.report({ node, messageId: "toastErrorInHandler" });
      },
    };
  },
});
