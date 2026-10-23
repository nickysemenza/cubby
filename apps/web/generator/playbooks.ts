import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compactLiteral, generatedHeader } from "./artifacts.ts";
import type { EntityArtifacts } from "./entities/declarations.ts";

import {
  PLAYBOOK_SKILLS,
  MARKDOWN_LINK,
  localTargets,
  playbookMarkdownFiles,
  skillMarkdownFiles,
} from "cubby/tooling/playbook-sources";

const SKILLS_ROOT = ".agents/skills";
const GITHUB_BLOB = "https://github.com/nickysemenza/cubby/blob/main/";

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

/**
 * Every playbook's Markdown files plus each repository Markdown file they
 * link to (one hop). Served links become repository paths readable with
 * `playbook.read`; anything else becomes its public GitHub URL, so no link in
 * a served file depends on the repository checkout.
 */
export async function collectPlaybooks(root: string): Promise<PlaybookBundle> {
  const sources = new Map(
    await Promise.all(
      playbookMarkdownFiles(root).map(
        async (file) =>
          [file, await readFile(resolve(root, file), "utf8")] as const,
      ),
    ),
  );
  const skills: PlaybookSkill[] = [];
  for (const skill of PLAYBOOK_SKILLS) {
    const directory = `${SKILLS_ROOT}/${skill}`;
    const files = skillMarkdownFiles(root, skill);
    const path = `${directory}/SKILL.md`;
    const raw = await readFile(resolve(root, path), "utf8");
    const { name, description } = skillFrontmatter(raw, path);
    if (name !== skill) throw new Error(`${path}: name must be ${skill}`);
    skills.push({ name, description, path, files });
  }
  const files: Record<string, string> = {};
  for (const [file, markdown] of [...sources].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const targets = new Map(
      localTargets(root, file, markdown).map((target) => [target.raw, target]),
    );
    files[file] = markdown.replaceAll(
      MARKDOWN_LINK,
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
    source:
      `${generatedHeader}export const PLAYBOOK_SKILLS = ${compactLiteral(bundle.skills)} as const;\n\n` +
      `export const PLAYBOOK_FILES: Readonly<Record<string, string>> = ${JSON.stringify(bundle.files)};\n`,
  };
}
