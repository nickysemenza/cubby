import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Browser code reads one entity's generated model at a time: the slim
 * `@cubby/schemas/entity-index` for always-loaded facts, and a route's
 * generated client module (or `useEntityModel`) for the heavy field model,
 * summary and descriptor. A value import of an all-entities aggregate pulls
 * every entity's model into whichever chunk imports it — the app shell, when
 * the importer is shared. Type-only imports erase and stay allowed.
 * docs/adr/0009-per-entity-client-manifests.md explains the split.
 */

const BOUNDARY = "See docs/adr/0009-per-entity-client-manifests.md.";

/** Package subpaths that collect every entity's model. */
const AGGREGATE_PACKAGES = new Set([
  "@cubby/schemas/entity-manifest",
  "@cubby/schemas/entity-summary",
  "@cubby/schemas/entity-fields",
  "@cubby/schemas/connected-views",
]);

/** The generated aggregate modules, reached by a relative or aliased path. */
const AGGREGATE_FILES =
  /(^|\/)generated\/entity-(manifest-data|summary|field-model|inspector)\.gen(\.ts)?$/u;

function aggregateSource(source: string): boolean {
  return AGGREGATE_PACKAGES.has(source) || AGGREGATE_FILES.test(source);
}

/**
 * Server-generated bindings and the entity kernel collect every entity's
 * command and result schemas for the server's own validation; the browser
 * reads its client-side generated modules instead.
 */
const SERVER_MODULES = /(^|\/)server\/(generated|entity-kernel)\//u;

/** A quoted string literal's value (`"zod"` → zod). */
function staticSource(node: ESTree.Node | null | undefined) {
  if (node?.type !== "Literal" || node.raw === null) return;
  if (!node.raw.startsWith('"') && !node.raw.startsWith("'")) return;
  return String(node.value);
}

export const noClientEntityAggregateRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep the all-entities generated model aggregates and server-generated bindings out of browser code.",
    },
    messages: {
      server: `"{{source}}" is server code that collects every entity's schemas. Browser code value-imports client modules (for example ~/entity/generated/entity-edit-inputs.gen); \`import type\` stays allowed. ${BOUNDARY}`,
      aggregate: `"{{source}}" collects every entity's generated model. Read always-loaded facts from @cubby/schemas/entity-index and one entity's model through ~/entity/entity-model (entityFieldModel, useEntityModel, EntityModelBoundary, loadEntityModels); \`import type\` stays allowed. ${BOUNDARY}`,
    },
  },
  createOnce(context) {
    const check = (
      node: ESTree.Node,
      source: ESTree.Node | null | undefined,
    ) => {
      const value = staticSource(source);
      if (value === undefined) return;
      if (aggregateSource(value))
        context.report({
          node,
          messageId: "aggregate",
          data: { source: value },
        });
      else if (SERVER_MODULES.test(value))
        context.report({ node, messageId: "server", data: { source: value } });
    };
    return {
      ImportDeclaration(node) {
        // `import { type X }` still emits a side-effect import under
        // `verbatimModuleSyntax`; only a whole-declaration `import type` erases.
        if (node.importKind === "type") return;
        check(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === "type") return;
        check(node, node.source);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") return;
        check(node, node.source);
      },
      ImportExpression(node) {
        check(node, node.source);
      },
    };
  },
});
