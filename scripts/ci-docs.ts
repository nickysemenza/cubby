import { resolve } from "node:path";
import { runtimeMarkdownFiles } from "./lib/playbook-sources.ts";

/** Fail closed: only repository docs and agent instructions can be editorial. */
export function isEditorialOnly(
  root: string,
  files: readonly string[],
): boolean {
  const runtime = new Set(runtimeMarkdownFiles(root));
  return (
    files.length > 0 &&
    files.every(
      (file) =>
        /\.(?:md|mdx|markdown)$/iu.test(file) &&
        (file.startsWith("docs/") ||
          /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/u.test(file)) &&
        !file.startsWith("docs/guide/") &&
        !runtime.has(file),
    )
  );
}

if (import.meta.main) {
  const files: unknown = JSON.parse(process.env.CHANGED_FILES ?? "null");
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string"))
    throw new Error("CHANGED_FILES must be a JSON array of repository paths");
  console.log(
    `runtime=${!isEditorialOnly(resolve(import.meta.dirname, ".."), files)}`,
  );
}
