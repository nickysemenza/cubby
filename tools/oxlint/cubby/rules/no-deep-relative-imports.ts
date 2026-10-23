import { defineRule, type ESTree } from "@oxlint/plugins";

function staticSource(node: ESTree.Node | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null;
  return null;
}

export const noDeepRelativeImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Use package exports or runtime-supported aliases for distant modules.",
    },
    messages: {
      deep: "Replace this deep relative module import with a package export or a runtime-supported alias. Nearby ./ and ../ imports are allowed; Node scripts stay TypeScript. See docs/development.md#typescript-imports.",
    },
  },
  createOnce(context) {
    const check = (node: ESTree.Node | undefined) => {
      const source = staticSource(node);
      if (node && source && /^(?:\.\.\/){3}/u.test(source))
        context.report({ node, messageId: "deep" });
    };
    return {
      ImportDeclaration(node) {
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source);
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      ImportExpression(node) {
        check(node.source);
      },
      TSImportType(node) {
        check(node.source);
      },
      TSExternalModuleReference(node) {
        check(node.expression);
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require")
          check(node.arguments[0]);
      },
    };
  },
});
