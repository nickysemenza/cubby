import { existsSync, readFileSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { walkFiles } from "./tree-digest.ts";

/** Household playbooks served by MCP and the Claude plugin. */
export const PLAYBOOK_SKILLS = [
  "purchase-import",
  "product-enrichment",
  "cubby-meal-logging",
  "log-household-maintenance",
  "photo-inventory-import",
  "garden-plan-import",
] as const;

export const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/gu;

/** Relative links resolved against `from`, as repository paths plus anchor. */
export function localTargets(root: string, from: string, markdown: string) {
  const targets: { raw: string; path: string; anchor: string }[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const raw = match[2] ?? "";
    if (/^(?:[a-z][a-z+.-]*:|#|\/)/iu.test(raw)) continue;
    const [file = "", anchor = ""] = raw.split("#", 2);
    const path = posix.normalize(posix.join(posix.dirname(from), file));
    if (path.startsWith("..") || !existsSync(resolve(root, path)))
      throw new Error(
        `${from}: link ${raw} does not resolve in the repository`,
      );
    targets.push({ raw, path, anchor: anchor ? `#${anchor}` : "" });
  }
  return targets;
}

export function skillMarkdownFiles(root: string, skill: string): string[] {
  return walkFiles(resolve(root, ".agents/skills", skill))
    .filter((file) => file.endsWith(".md"))
    .map((file) => relative(root, file))
    .sort();
}

/** One hop from skill sources, exactly as served by the playbook generator. */
export function playbookMarkdownFiles(root: string): string[] {
  const own = PLAYBOOK_SKILLS.flatMap((skill) =>
    skillMarkdownFiles(root, skill),
  );
  const linked = own.flatMap((file) =>
    localTargets(root, file, readFileSync(resolve(root, file), "utf8"))
      .map((target) => target.path)
      .filter((file) => file.endsWith(".md")),
  );
  return [...new Set([...own, ...linked])].sort();
}

/** Markdown consumed by the app's guide, prompts and served playbooks. */
export function runtimeMarkdownFiles(root: string): string[] {
  return [
    ...new Set([
      ...playbookMarkdownFiles(root),
      ...walkFiles(resolve(root, "docs/guide"))
        .filter((file) => file.endsWith(".md"))
        .map((file) => relative(root, file)),
    ]),
  ].sort();
}
