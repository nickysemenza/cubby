import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

function isOwnedPrivateIdentifier(node: ESTree.PrivateIdentifier): boolean {
  const parent = node.parent;
  return (
    (parent.type === "PropertyDefinition" ||
      parent.type === "TSAbstractPropertyDefinition" ||
      parent.type === "AccessorProperty" ||
      parent.type === "TSAbstractAccessorProperty" ||
      parent.type === "MethodDefinition" ||
      parent.type === "TSAbstractMethodDefinition") &&
    parent.key === node
  );
}

/** Ban "shape" in bindings owned by the current module and in private members. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in locally owned JavaScript and TypeScript symbols.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const ownedIdentifiers = new Set<ESTree.Identifier>();

    const reportForbiddenSymbolName = (
      node: ESTree.Node & { name: string },
    ) => {
      if (!containsForbiddenSymbolName(node.name)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Program() {
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const variable of scope.variables) {
            for (const identifier of variable.identifiers) {
              ownedIdentifiers.add(identifier);
            }
          }
        }
      },
      Identifier(node) {
        if (!ownedIdentifiers.has(node)) return;
        const parent = node.parent;
        if (
          parent.type === "ImportSpecifier" &&
          parent.local === node &&
          parent.imported.name === node.name
        )
          return;
        reportForbiddenSymbolName(node);
      },
      PrivateIdentifier(node) {
        if (isOwnedPrivateIdentifier(node)) reportForbiddenSymbolName(node);
      },
    };
  },
});
