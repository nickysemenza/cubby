import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Enforcement layer for the "error surfaces stay raw" product rule (see
 * AGENTS.md "Product constraints"): the trusted household is the only
 * audience, so a caught error must reach the user (toast/Details) or be
 * rethrown — never silently dropped. Flags both shapes Cubby uses:
 *
 *   try { ... } catch (error) { ...swallowed... }
 *   promise.catch((error) => { ...swallowed... })
 *
 * Scope decisions (documented, not oversights):
 *  - A destructured/array catch or callback binding (`catch ({ message })`)
 *    is not analyzed for references — skipped entirely rather than risk a
 *    false positive, since the overwhelming common case is `catch (error)`.
 *  - "References the binding" ignores identifiers that are themselves a
 *    non-computed member/property NAME (`x.error`, `{ error: 1 }`) — those
 *    name an unrelated property, not the caught error.
 *  - The `console.<x>(...)` exception matches the bare identifier or a
 *    non-computed member chain off it (`console.error(error)`,
 *    `console.error(error.message)`) passed directly as one of the call's
 *    arguments. A reference buried deeper (e.g. wrapped in a helper call
 *    before reaching console) is NOT exempted and counts as a real
 *    reference, so it does not on its own trigger this rule.
 *  - An arrow `.catch()` callback with a concise (expression) body produces
 *    a value, the same intent as an explicit `return`, so it is not flagged —
 *    except when that value is the literal `undefined`, `null`, or `void 0`
 *    AND the `.catch()` result itself is discarded, which is the plainest
 *    swallow shape of all.
 */

const MESSAGE =
  "Caught error is discarded: surface it (showErrorToast / render getAppErrorDetails(error).message / rethrow) or annotate the catch body with `// SILENT: <reason>`.";

const SILENT_PATTERN = /^\s*SILENT:\s*\S/u;

/** Statement/declaration kinds the leading-comment search stops climbing at. */
const SILENT_COMMENT_OWNER_KINDS = new Set([
  "CatchClause",
  "ExpressionStatement",
  "VariableDeclaration",
  "ReturnStatement",
  "ThrowStatement",
  "PropertyDefinition",
]);

type CatchCallback = ESTree.ArrowFunctionExpression | ESTree.Function;

type CatchBinding =
  | { kind: "none" }
  | { kind: "named"; name: string; declaration: ESTree.Node }
  | { kind: "complex" };

interface CatchContext {
  reportNode: ESTree.CatchClause | ESTree.CallExpression;
  binding: CatchBinding;
  /** Function-nesting depth (see `functionDepth` below) when this context's
   * own body started — a throw/return only "belongs" to this context while
   * that depth is unchanged, i.e. before crossing into a nested function. */
  baseFunctionDepth: number;
  hasEscape: boolean;
  referenced: boolean;
}

function catchBindingFromPattern(
  param: ESTree.BindingPattern | null,
): CatchBinding {
  if (param === null) return { kind: "none" };
  if (param.type === "Identifier")
    return { kind: "named", name: param.name, declaration: param };
  return { kind: "complex" };
}

function catchBindingFromFirstParam(
  params: readonly ESTree.ParamPattern[],
): CatchBinding {
  const [first] = params;
  if (first === undefined) return { kind: "none" };
  if (first.type === "Identifier")
    return { kind: "named", name: first.name, declaration: first };
  return { kind: "complex" };
}

/** `undefined`, `null`, or `void 0` as a concise arrow body. */
function isNothingLiteral(node: ESTree.Expression): boolean {
  return (
    (node.type === "Identifier" && node.name === "undefined") ||
    (node.type === "Literal" && node.value === null) ||
    (node.type === "UnaryExpression" && node.operator === "void")
  );
}

function isDiscardedResult(node: ESTree.CallExpression): boolean {
  const { parent } = node;
  return (
    parent.type === "ExpressionStatement" ||
    (parent.type === "UnaryExpression" && parent.operator === "void") ||
    (parent.type === "ArrowFunctionExpression" && parent.body === node)
  );
}

function isPromiseCatchCall(node: ESTree.CallExpression): boolean {
  const { callee } = node;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "catch"
  );
}

function isConsoleCallee(callee: ESTree.Expression): boolean {
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "console"
  );
}

/** True when `node` is only reached through a non-computed member chain
 * (`error`, `error.message`, `error.cause.message`, …) passed directly as
 * one of the arguments of a `console.<x>(...)` call. */
function isConsoleLoggingReference(node: ESTree.Node): boolean {
  let current: ESTree.Node = node;
  while (
    current.parent.type === "MemberExpression" &&
    !current.parent.computed &&
    current.parent.object === current
  ) {
    current = current.parent;
  }
  const { parent } = current;
  return (
    parent.type === "CallExpression" &&
    isConsoleCallee(parent.callee) &&
    parent.arguments.some((argument) => argument === current)
  );
}

/** True when `node` is a member/property NAME, not a value reference:
 * `x.error` (the `.error`) or `{ error: 1 }` (the key). */
function isNonReferencingIdentifier(node: ESTree.Node): boolean {
  const { parent } = node;
  if (
    parent.type === "MemberExpression" &&
    !parent.computed &&
    parent.property === node
  )
    return true;
  return (
    parent.type === "Property" &&
    !parent.computed &&
    !parent.shorthand &&
    parent.key === node
  );
}

/** Port of the `anti-slop/require-safety-comment-for-type-assertion` climb:
 * check the node's own leading comment, then its enclosing statement's, and
 * so on outward, stopping at the first statement/declaration boundary. */
function hasLeadingSilentComment(
  sourceCode: {
    getCommentsBefore(node: ESTree.Node): readonly { value: string }[];
  },
  node: ESTree.CatchClause | ESTree.CallExpression,
): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some((comment) => SILENT_PATTERN.test(comment.value))
    )
      return true;
    if (
      SILENT_COMMENT_OWNER_KINDS.has(current.type) ||
      current.parent.type === "Program"
    )
      return false;
    current = current.parent;
  }
}

function hasTrailingSameLineSilentComment(
  allComments: readonly ESTree.Comment[],
  node: ESTree.CatchClause | ESTree.CallExpression,
): boolean {
  const line = node.loc.start.line;
  return allComments.some(
    (comment) =>
      comment.start > node.start &&
      comment.loc.start.line === line &&
      SILENT_PATTERN.test(comment.value),
  );
}

/** The natural annotation spot — the first line inside the catch body
 * (`} catch { // SILENT: … }`) or inside a `.catch(() => { // SILENT: … })`
 * callback — so a reason never has to sit between `}` and `catch`. */
function hasSilentCommentInsideBody(
  allComments: readonly ESTree.Comment[],
  node: ESTree.CatchClause | ESTree.CallExpression,
): boolean {
  const body =
    node.type === "CatchClause"
      ? node.body
      : (node.arguments[0]?.type === "ArrowFunctionExpression" ||
            node.arguments[0]?.type === "FunctionExpression") &&
          node.arguments[0].body.type === "BlockStatement"
        ? node.arguments[0].body
        : undefined;
  if (!body) return false;
  return allComments.some(
    (comment) =>
      comment.start > body.start &&
      comment.end < body.end &&
      SILENT_PATTERN.test(comment.value),
  );
}

/** Cubby's "discarded catch" gate: a caught error that is neither surfaced
 * nor rethrown/returned, and isn't annotated as an intentional `SILENT:` drop. */
export const noSwallowedCatchRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a catch clause or promise `.catch()` callback that discards the caught error instead of surfacing or rethrowing it.",
    },
    messages: {
      swallowedCatch: MESSAGE,
    },
  },
  createOnce(context) {
    // `createOnce` runs once for the plugin's whole lifetime, not per file
    // (mirrors `no-unsafe-identifiers.ts`'s `catalog`) — every mutable piece
    // of state here is reset in `Program`, and `context.sourceCode` itself is
    // only reachable from inside a visitor callback, never at this point.
    let allComments: readonly ESTree.Comment[] = [];
    let stack: CatchContext[] = [];
    let pendingCatchCallbacks = new Map<CatchCallback, ESTree.CallExpression>();
    let functionDepth = 0;

    function evaluate(ctx: CatchContext) {
      if (ctx.hasEscape) return;
      if (ctx.binding.kind === "complex") return;
      if (ctx.binding.kind === "named" && ctx.referenced) return;
      if (
        hasLeadingSilentComment(context.sourceCode, ctx.reportNode) ||
        hasTrailingSameLineSilentComment(allComments, ctx.reportNode) ||
        hasSilentCommentInsideBody(allComments, ctx.reportNode)
      )
        return;
      context.report({ node: ctx.reportNode, messageId: "swallowedCatch" });
    }

    function markEscape() {
      const top = stack.at(-1);
      if (top !== undefined && top.baseFunctionDepth === functionDepth)
        top.hasEscape = true;
    }

    function pushIfPendingCatchCallback(node: CatchCallback) {
      const reportNode = pendingCatchCallbacks.get(node);
      if (reportNode === undefined) return;
      stack.push({
        reportNode,
        binding: catchBindingFromFirstParam(node.params),
        baseFunctionDepth: functionDepth,
        hasEscape: false,
        referenced: false,
      });
    }

    function popIfPendingCatchCallback(node: CatchCallback) {
      if (!pendingCatchCallbacks.delete(node)) return;
      const ctx = stack.pop();
      if (ctx !== undefined) evaluate(ctx);
    }

    return {
      Program() {
        allComments = context.sourceCode.getAllComments();
        stack = [];
        pendingCatchCallbacks = new Map();
        functionDepth = 0;
      },

      CatchClause(node) {
        stack.push({
          reportNode: node,
          binding: catchBindingFromPattern(node.param),
          baseFunctionDepth: functionDepth,
          hasEscape: false,
          referenced: false,
        });
      },
      "CatchClause:exit"() {
        const ctx = stack.pop();
        if (ctx !== undefined) evaluate(ctx);
      },

      CallExpression(node) {
        if (!isPromiseCatchCall(node)) return;
        const [callback] = node.arguments;
        if (
          callback === undefined ||
          (callback.type !== "ArrowFunctionExpression" &&
            callback.type !== "FunctionExpression")
        )
          return;
        if (callback.body === null) return;
        if (callback.body.type !== "BlockStatement") {
          // `await x.catch(() => null)` is a value fallback the caller reads;
          // only a discarded result (`void x.catch(() => undefined)`, or the
          // call as a bare statement) is a swallow.
          if (
            isNothingLiteral(callback.body) &&
            isDiscardedResult(node) &&
            !hasLeadingSilentComment(context.sourceCode, node) &&
            !hasTrailingSameLineSilentComment(allComments, node)
          )
            context.report({ node, messageId: "swallowedCatch" });
          return;
        }
        pendingCatchCallbacks.set(callback, node);
      },

      ArrowFunctionExpression(node) {
        functionDepth += 1;
        pushIfPendingCatchCallback(node);
      },
      "ArrowFunctionExpression:exit"(node) {
        popIfPendingCatchCallback(node);
        functionDepth -= 1;
      },
      FunctionExpression(node) {
        functionDepth += 1;
        pushIfPendingCatchCallback(node);
      },
      "FunctionExpression:exit"(node) {
        popIfPendingCatchCallback(node);
        functionDepth -= 1;
      },
      FunctionDeclaration() {
        functionDepth += 1;
      },
      "FunctionDeclaration:exit"() {
        functionDepth -= 1;
      },

      Identifier(node) {
        // Innermost binding of that name wins, as in scoping: a nested
        // `.catch((error) => use(error))` must not vouch for an outer
        // `catch (error) {}` that shares the name.
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          const ctx = stack[index];
          if (
            ctx === undefined ||
            ctx.binding.kind !== "named" ||
            node.name !== ctx.binding.name
          )
            continue;
          // The binding's own declaration site (`catch (error)`, `(error) =>`)
          // is itself visited as an Identifier — it is not a use.
          if (
            node !== ctx.binding.declaration &&
            !isNonReferencingIdentifier(node) &&
            !isConsoleLoggingReference(node)
          )
            ctx.referenced = true;
          return;
        }
      },

      ThrowStatement() {
        markEscape();
      },
      ReturnStatement(node) {
        if (node.argument !== null) markEscape();
      },
    };
  },
});
