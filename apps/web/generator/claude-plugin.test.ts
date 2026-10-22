import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { renderClaudePlugin } from "./claude-plugin.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// The plugin is read from GitHub, so it is committed rather than generated on
// install; a playbook rename or description change must reach it.
test("committed Claude plugin matches the playbooks (run pnpm --dir apps/web generate:claude-plugin)", async () => {
  for (const file of await renderClaudePlugin(root))
    assert.deepEqual(
      {
        path: file.path,
        content: await readFile(resolve(root, file.path), "utf8").catch(
          () => null,
        ),
      },
      { path: file.path, content: file.content },
    );
});
