import { compactLiteral, rawSource } from "../../artifacts.ts";

/** Legacy record rendering for rawSource emitters; migrate callers to tsModule. */
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
  rawSource(
    `${comment ? `${comment}\n` : ""}// oxfmt-ignore\n${
      exported ? "export " : ""
    }const ${name} = ${compactLiteral(entries)} as const${
      satisfies ? ` satisfies ${satisfies}` : ""
    };\n`,
  );
