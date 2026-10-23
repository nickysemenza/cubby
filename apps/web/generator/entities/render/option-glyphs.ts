import { createRequire } from "node:module";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { generatedHeader } from "../../artifacts.ts";
import {
  booleanCellOptions,
  expenseLineAutoOption,
} from "#web/src/lib/select-options.ts";

/** Static paths keep browser chunks bounded; declarations own the inventory. */
export function renderOptionGlyphs(
  entities: readonly CompiledEntity[],
): EntityArtifacts {
  const eager = new Set<string>();
  const names = new Set<string>();
  const require = createRequire(import.meta.url);
  const options = entities.flatMap((entity) =>
    entity.fieldModel.fields.flatMap((field) => [
      ...(field.control?.options ?? []),
      ...(field.display.valueOptions ?? []),
    ]),
  );
  for (const option of [
    ...options,
    ...booleanCellOptions({ true: "Yes", false: "No" }),
    expenseLineAutoOption,
  ]) {
    if (!option.glyph) continue;
    const name = option.glyph.phosphor;
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name))
      throw new Error(`Invalid Phosphor glyph ${name}`);
    require.resolve(`@phosphor-icons/react/dist/csr/${name}`);
    names.add(name);
    if (option.role === "status") eager.add(name);
  }
  const sorted = [...names].sort();
  return {
    relativePath: "apps/web/src/ui/common/option-glyphs.gen.ts",
    source:
      generatedHeader +
      'import type {Icon} from "@phosphor-icons/react/lib";\n' +
      [...eager]
        .sort()
        .map(
          (name) =>
            `import {${name}Icon} from "@phosphor-icons/react/dist/csr/${name}";`,
        )
        .join("\n") +
      `\nexport const EAGER = new Map<string, Icon>([${[...eager]
        .sort()
        .map((name) => `["${name}", ${name}Icon]`)
        .join(",")}]);\n` +
      `export const LAZY = new Map<string, () => Promise<Icon>>([${sorted
        .filter((name) => !eager.has(name))
        .map(
          (name) =>
            `["${name}", () => import("@phosphor-icons/react/dist/csr/${name}").then(m => m.${name}Icon)]`,
        )
        .join(",")}]);\n`,
  };
}
