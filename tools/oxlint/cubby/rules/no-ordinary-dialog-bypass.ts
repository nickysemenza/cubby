import { defineRule, type ESTree } from "@oxlint/plugins";
import { dirname, resolve } from "node:path";

// Match relative paths as well as the web alias; aliases of imported bindings
// cannot change whether a caller owns a low-level dialog composition.
function dialogModule(source: string, filename: string): boolean {
  const path = source.startsWith(".")
    ? resolve(dirname(filename), source)
    : source;
  return (
    /(?:^|\/)ui\/primitives\/(?:dialog|sheet)(?:\.[cm]?[jt]sx?)?$/u.test(
      path,
    ) || /^@base-ui\/react\/dialog(?:\/.*)?$/u.test(source)
  );
}

function staticSource(node: ESTree.Node | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null;
  return null;
}

export const noOrdinaryDialogBypassRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Ordinary dialogs and workspace panels use Overlay." },
    messages: {
      overlay:
        "Use Overlay for ordinary dialogs/panels. DialogTrigger remains available. Specialized low-level surfaces require an exact-path exception with a documented reason in apps/web/DESIGN.md.",
    },
  },
  createOnce(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        for (const specifier of node.specifiers) {
          const name =
            specifier.type === "ImportSpecifier"
              ? specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value
              : null;
          if (
            (dialogModule(source, context.filename) &&
              name !== "DialogTrigger") ||
            (source === "@base-ui/react" &&
              (name === null || name === "Dialog"))
          )
            context.report({ node: specifier, messageId: "overlay" });
        }
      },
      ExportNamedDeclaration(node) {
        const source = node.source?.value;
        if (typeof source !== "string") return;
        for (const specifier of node.specifiers) {
          const name =
            specifier.local.type === "Identifier"
              ? specifier.local.name
              : specifier.local.value;
          if (
            (dialogModule(source, context.filename) &&
              name !== "DialogTrigger") ||
            (source === "@base-ui/react" && name === "Dialog")
          )
            context.report({ node: specifier, messageId: "overlay" });
        }
      },
      ExportAllDeclaration(node) {
        const source = node.source.value;
        if (
          typeof source === "string" &&
          (dialogModule(source, context.filename) ||
            source === "@base-ui/react")
        )
          context.report({ node, messageId: "overlay" });
      },
      ImportExpression(node) {
        const source = staticSource(node.source);
        if (
          source &&
          (dialogModule(source, context.filename) ||
            source === "@base-ui/react")
        )
          context.report({ node, messageId: "overlay" });
      },
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "require")
          return;
        const source = staticSource(node.arguments[0]);
        if (
          source &&
          (dialogModule(source, context.filename) ||
            source === "@base-ui/react")
        )
          context.report({ node, messageId: "overlay" });
      },
    };
  },
});
