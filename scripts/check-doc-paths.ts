/**
 * Fail when a maintained doc names a repo path that no longer exists. Agents
 * follow these paths literally; a moved file sent them guessing (session logs
 * showed the same dead paths retried across many runs). Plans, ADRs and
 * reports are dated records and are skipped; gitignored outputs (`.env`, test output) pass.
 *
 * Usage: `node scripts/check-doc-paths.ts`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS =
  "apps|packages|docs|scripts|tools|recipebridge|cubby-ffi|\\.claude|\\.agents|\\.github";
const backticked = new RegExp(`\`((?:${ROOTS})/[^\`\\s]+)\``, "g");
const linked = /\]\(([^)\s]+)\)/g;
const placeholder = /[*<>{}$]|\.\.\./;

/** `doc:line -> path` for every referenced path `isKnown` rejects. */
export function findDeadPaths(
  docs: readonly { path: string; text: string }[],
  isKnown: (path: string) => boolean,
): string[] {
  const dead: string[] = [];
  for (const doc of docs) {
    doc.text.split("\n").forEach((line, index) => {
      const targets = [
        ...[...line.matchAll(backticked)].map(([, path]) => path!),
        ...[...line.matchAll(linked)]
          .map(([, href]) => href!)
          .filter((href) => !/^(?:[a-z]+:|#|\/)/.test(href))
          .map((href) => posix.join(posix.dirname(doc.path), href)),
      ];
      for (const raw of targets) {
        const path = raw.replace(/[#:].*$/, "").replace(/\/$/, "");
        if (!path || placeholder.test(path) || isKnown(path)) continue;
        dead.push(`${doc.path}:${index + 1} -> ${path}`);
      }
    });
  }
  return dead;
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", input });
  const tracked = git(["ls-files"]).split("\n").filter(Boolean);
  const known = new Set(tracked);
  for (const file of tracked)
    for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir))
      known.add(dir);
  const docs = tracked
    .filter((file) => file.endsWith(".md"))
    .filter(
      (file) => !/^docs\/(?:plans|adr|reports)\/|CHANGELOG\.md$/.test(file),
    )
    .map((path) => ({ path, text: readFileSync(`${root}/${path}`, "utf8") }));
  const candidates = findDeadPaths(docs, (path) => known.has(path));
  const missing = [
    ...new Set(candidates.map((entry) => entry.split(" -> ")[1]!)),
  ];
  // `check-ignore` exits 1 when nothing is ignored.
  let ignored = new Set<string>();
  try {
    ignored = new Set(
      git(
        ["check-ignore", "--no-index", "--stdin"],
        // A directory pattern (`DerivedData/`) only matches with the slash.
        missing.flatMap((path) => [path, `${path}/`]).join("\n"),
      )
        .split("\n")
        .map((path) => path.replace(/\/$/, "")),
    );
  } catch {}
  const dead = candidates.filter(
    (entry) => !ignored.has(entry.split(" -> ")[1]!),
  );
  if (dead.length === 0) return;
  console.error(
    `Docs reference ${dead.length} missing repo path(s); fix the path or drop the reference:\n${dead.map((entry) => `  ${entry}`).join("\n")}`,
  );
  process.exit(1);
}

if (import.meta.main) main();
