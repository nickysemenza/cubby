import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

interface SafetyCommentOptions {
  allowLiteralTypes?: boolean;
}

function isSafetyCommentOptions(value: unknown): value is SafetyCommentOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `x as "open" | "closed"` narrows to literals the surrounding code already enumerates. */
function isLiteralTypeAssertion(node: TypeAssertion): boolean {
  const type = node.typeAnnotation;
  if (type.type === "TSLiteralType") return true;
  return (
    type.type === "TSUnionType" &&
    type.types.every((member) => member.type === "TSLiteralType")
  );
}

function isExportDeclaration(node: ESTree.Node): boolean {
  return (
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportDefaultDeclaration"
  );
}

function hasSafetyComment(
  sourceCode: SourceCode,
  node: TypeAssertion,
): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some(
          (comment) =>
            comment.end <= node.start && /\bSAFETY\s*:/u.test(comment.value),
        )
    ) {
      return true;
    }
    if (
      (commentOwnerKinds.has(current.type) &&
        !isExportDeclaration(current.parent)) ||
      current.parent.type === "Program"
    )
      return false;
    current = current.parent;
  }
}

/** Require type assertions to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions and, with `allowLiteralTypes`, literal-type narrowing.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowLiteralTypes: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowLiteralTypes: false }],
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      const option = context.options?.[0];
      const allowLiteralTypes =
        isSafetyCommentOptions(option) && option.allowLiteralTypes === true;
      if (
        isConstAssertion(node) ||
        (allowLiteralTypes && isLiteralTypeAssertion(node)) ||
        hasSafetyComment(context.sourceCode, node)
      )
        return;
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
