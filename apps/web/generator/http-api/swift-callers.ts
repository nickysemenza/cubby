import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SwiftCallers {
  /** Every identifier in handwritten Swift, including tests. */
  tokens: ReadonlySet<string>;
  /** Every string literal shaped like an operation id. */
  operationIds: ReadonlySet<string>;
}

// Build products and generated output are not callers. Generated Swift stays out
// so that generation never depends on its own previous output.
const SKIPPED_DIRECTORIES = new Set([
  ".build",
  ".swiftpm",
  "build",
  "DerivedData",
  "Generated",
  "Models",
  "node_modules",
]);

const swiftFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : swiftFiles(path);
    return entry.name.endsWith(".swift") ? [path] : [];
  });

/** A static name scan: it can keep too much, and the compiler catches too little. */
export function scanSwiftCallers(appleRoot: string): SwiftCallers {
  const tokens = new Set<string>();
  const operationIds = new Set<string>();
  for (const file of swiftFiles(appleRoot)) {
    const source = readFileSync(file, "utf8");
    for (const [token] of source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/gu))
      tokens.add(token);
    for (const match of source.matchAll(/"([a-zA-Z]+\.[a-zA-Z]+)"/gu))
      operationIds.add(match[1]!);
  }
  return { tokens, operationIds };
}
