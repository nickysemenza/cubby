import { compactLiteral } from "../artifacts.ts";

/**
 * Renders one `// oxfmt-ignore`-guarded generated record constant: a
 * `compactLiteral` object or array literal assigned to a single name, with an
 * optional leading comment and `satisfies` clause. Every compiled-entity
 * roster the generator emits this way (`SHORTCODE_PREFIX`, `entityNames`,
 * `generatedEntityFilterContractCases`, …) goes through this one function so
 * the shape of that emission — and the ignore comment oxfmt needs directly
 * above the statement it guards — stays in exactly one place instead of
 * copy-pasted at each call site.
 *
 * Not every generated record fits this shape: a `satisfies` clause that isn't
 * a single type expression, a literal assembled by joining strings instead of
 * `compactLiteral`, or two statements sharing one leading comment all stay as
 * hand-written template strings at their call sites rather than forcing a
 * third knob onto this helper.
 */
export const renderRecord = ({
  name,
  entries,
  satisfies,
  comment,
  exported = true,
}: {
  name: string;
  entries: unknown;
  satisfies?: string;
  comment?: string;
  exported?: boolean;
}): string =>
  `${comment ? `${comment}\n` : ""}// oxfmt-ignore\n${
    exported ? "export " : ""
  }const ${name} = ${compactLiteral(entries)} as const${
    satisfies ? ` satisfies ${satisfies}` : ""
  };\n`;
