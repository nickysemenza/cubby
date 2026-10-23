import { relative, resolve } from "node:path";
import {
  playbookMarkdownFiles,
  runtimeMarkdownFiles,
} from "./lib/playbook-sources.ts";
import { digestFiles, walkFiles } from "./lib/tree-digest.ts";

const root = resolve(import.meta.dirname, "..");
const files = process.argv.includes("--playbooks")
  ? playbookMarkdownFiles(root)
  : runtimeMarkdownFiles(root);
if (process.argv.includes("--plugins"))
  files.push(
    ...walkFiles(resolve(root, "plugins"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => relative(root, file)),
  );
console.log(
  digestFiles(
    root,
    files.sort().map((file) => resolve(root, file)),
  ),
);
