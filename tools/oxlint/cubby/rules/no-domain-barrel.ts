import { defineRule } from "@oxlint/plugins";

/**
 * `index.ts` re-export barrels hide which module owns a symbol and widen every
 * importer's module graph. Domain, generic-capability, and client feature
 * folders import the owning module directly (docs/adr/0019-domain-first-server-layout.md);
 * platform barrels such as `ui/layout/index.ts` predate the rule and stay.
 */
const BARREL_SCOPE =
  /(?:^|\/)apps\/web\/src\/(?:server\/(?:domains|generic)|features)\/(?:.+\/)?index\.tsx?$/u;

export const noDomainBarrelRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow re-export barrels in domains/*, generic/*, and features/*.",
    },
    messages: {
      barrel:
        "Do not re-export from an index barrel here; import the owning module directly.",
    },
  },
  create(context) {
    if (!BARREL_SCOPE.test(context.filename.replaceAll("\\", "/"))) return {};
    return {
      ExportNamedDeclaration(node) {
        if (node.source) context.report({ node, messageId: "barrel" });
      },
      ExportAllDeclaration(node) {
        context.report({ node, messageId: "barrel" });
      },
    };
  },
});
