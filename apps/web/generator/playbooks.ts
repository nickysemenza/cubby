import { rawSource } from "./artifacts.ts";
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";

import { compactLiteral, generatedHeader } from "./artifacts.ts";
import type { EntityArtifacts } from "./entities/declarations.ts";

/**
 * The household skills every MCP client reads as playbooks (`playbook` tool,
 * `skill://` resources, the Claude plugin's pointer stubs). Engineering skills
 * stay repository-only.
 */
const PLAYBOOK_SKILLS = [
  "purchase-import",
  "financial-evidence-import",
  "product-enrichment",
  "cubby-meal-logging",
  "log-household-maintenance",
  "photo-inventory-import",
  "garden-plan-import",
] as const;

const SKILLS_ROOT = ".agents/skills";
const GITHUB_BLOB = "https://github.com/nickysemenza/cubby/blob/main/";
const LINK = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/gu;

interface PlaybookSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly files: readonly string[];
}

interface PlaybookBundle {
  readonly skills: readonly PlaybookSkill[];
  /** Every served file by repository path, links rewritten. */
  readonly files: Readonly<Record<string, string>>;
}

/** SKILL.md frontmatter `name` and `description` (single-line values). */
function skillFrontmatter(raw: string, path: string) {
  const block = /^---\n([\s\S]*?)\n---\n/u.exec(raw)?.[1];
  const field = (key: string) =>
    block
      ?.split("\n")
      .find((line) => line.startsWith(`${key}:`))
      ?.slice(key.length + 1)
      .trim();
  const name = field("name");
  const description = field("description");
  if (!name || !description)
    throw new Error(`${path}: frontmatter needs name and description`);
  return { name, description };
}

/** Relative links resolved against `from`, as repository paths plus anchor. */
function localTargets(root: string, from: string, markdown: string) {
  const targets: { raw: string; path: string; anchor: string }[] = [];
  for (const match of markdown.matchAll(LINK)) {
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

/**
 * Every playbook's Markdown files plus each repository Markdown file they
 * link to (one hop). Served links become repository paths readable with
 * `playbook.read`; anything else becomes its public GitHub URL, so no link in
 * a served file depends on the repository checkout.
 */
export async function collectPlaybooks(root: string): Promise<PlaybookBundle> {
  const sources = new Map<string, string>();
  const skills: PlaybookSkill[] = [];
  for (const skill of PLAYBOOK_SKILLS) {
    const directory = `${SKILLS_ROOT}/${skill}`;
    const files: string[] = [];
    for await (const file of glob("**/*.md", { cwd: resolve(root, directory) }))
      files.push(`${directory}/${file}`);
    files.sort();
    const path = `${directory}/SKILL.md`;
    const raw = await readFile(resolve(root, path), "utf8");
    const { name, description } = skillFrontmatter(raw, path);
    if (name !== skill) throw new Error(`${path}: name must be ${skill}`);
    for (const file of files)
      sources.set(file, await readFile(resolve(root, file), "utf8"));
    skills.push({ name, description, path, files });
  }
  // One hop: only the skills' own links, so docs-of-docs stay GitHub links.
  for (const file of skills.flatMap((skill) => skill.files)) {
    for (const { path } of localTargets(root, file, sources.get(file) ?? "")) {
      if (path.endsWith(".md") && !sources.has(path))
        sources.set(path, await readFile(resolve(root, path), "utf8"));
    }
  }
  const files: Record<string, string> = {};
  for (const [file, markdown] of [...sources].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const targets = new Map(
      localTargets(root, file, markdown).map((target) => [target.raw, target]),
    );
    files[file] = markdown.replaceAll(
      LINK,
      (whole, text: string, raw: string) => {
        const target = targets.get(raw);
        if (!target) return whole;
        const href = sources.has(target.path)
          ? target.path
          : `${GITHUB_BLOB}${target.path}`;
        return `[${text}](${href}${target.anchor})`;
      },
    );
  }
  return { skills, files };
}

export async function renderPlaybookArtifact(
  root: string,
): Promise<EntityArtifacts> {
  const bundle = await collectPlaybooks(root);
  return {
    relativePath: "apps/web/src/server/generated/playbooks.gen.ts",
    source: rawSource(
      `${generatedHeader}export const PLAYBOOK_SKILLS = ${compactLiteral(bundle.skills)} as const;\n\n` +
        `export const PLAYBOOK_FILES: Readonly<Record<string, string>> = ${JSON.stringify(bundle.files)};\n`,
    ),
  };
}
