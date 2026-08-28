import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = execFileSync(
  "git",
  ["ls-files", "apps/web/src/server/repo/**/*.ts"],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter((file) => file && !file.includes(".test."));

const unsafeAny = /\bANY\s*\(\s*\$\{(?!uuidArrayParam\()/g;
const unsafeOverlap = /&&\s*\$\{/g;
const failures: string[] = [];

for (const file of files) {
  const source = readFileSync(resolve(root, file), "utf8");
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) =>
      "\n".repeat(comment.split("\n").length - 1),
    )
    .replace(/^\s*\/\/.*$/gm, "");
  for (const [name, pattern] of [
    ["ANY(${array})", unsafeAny],
    ["&& ${array}", unsafeOverlap],
  ] as const) {
    pattern.lastIndex = 0;
    for (const match of executableSource.matchAll(pattern)) {
      const line = executableSource.slice(0, match.index).split("\n").length;
      failures.push(
        `${file}:${line}: unsafe ${name}; use the typed query helper`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`OK: SQL safety passed (${files.length} repository files).`);
