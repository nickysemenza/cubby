import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderClaudePlugin } from "./claude-plugin.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("committed Claude plugin", () => {
  // The plugin is read from GitHub, so it is committed rather than generated
  // on install; a playbook rename or description change must reach it.
  it("matches the playbooks (run pnpm --dir apps/web generate:claude-plugin)", async () => {
    for (const file of await renderClaudePlugin(root))
      expect({
        path: file.path,
        content: await readFile(resolve(root, file.path), "utf8").catch(
          () => null,
        ),
      }).toEqual({ path: file.path, content: file.content });
  });
});
