import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdownFiles = execFileSync(
  "git",
  ["ls-files", "--", "*.md", "*.mdx"],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

const failures = [];
const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;

for (const file of markdownFiles) {
  const content = readFileSync(resolve(repositoryRoot, file), "utf8");
  for (const match of content.matchAll(markdownLink)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const target = raw.startsWith("<")
      ? raw.slice(1, raw.indexOf(">"))
      : raw.split(/\s+/u, 1)[0];
    if (
      !target ||
      target.startsWith("#") ||
      target.startsWith("/") ||
      /^[a-z][a-z\d+.-]*:/iu.test(target)
    ) {
      continue;
    }

    const path = decodeURIComponent(target.split("#", 1)[0].split("?", 1)[0]);
    if (!path) continue;
    if (!existsSync(resolve(repositoryRoot, dirname(file), path))) {
      const line = content.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line}: ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Broken relative Markdown links:\n");
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked relative links in ${markdownFiles.length} Markdown files.`);
}
