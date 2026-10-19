import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectPlaybooks } from "./playbooks.ts";

/**
 * The committed Claude plugin (`plugins/cubby`, listed by the repository's
 * `.claude-plugin/marketplace.json`). Its skills are pointer stubs: the text
 * lives on the MCP server (`playbook` tool), so the plugin only changes when a
 * playbook's name or description does. It declares no MCP server because each
 * member already has the Cubby connector; a plugin copy would duplicate it.
 * `claude-plugin.unit.test.ts` fails when the committed files drift; rerun
 * `pnpm --dir apps/web generate:claude-plugin` to rewrite them.
 */
export async function renderClaudePlugin(root: string) {
  const { skills } = await collectPlaybooks(root);
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const description =
    "Cubby household playbooks (purchase import, product enrichment, meal and maintenance logging, photo inventory, garden plans), served by the Cubby MCP connector.";
  return [
    {
      path: ".claude-plugin/marketplace.json",
      content: json({
        name: "cubby",
        owner: { name: "Nicky Semenza" },
        plugins: [{ name: "cubby", source: "./plugins/cubby", description }],
      }),
    },
    {
      path: "plugins/cubby/.claude-plugin/plugin.json",
      content: json({
        name: "cubby",
        displayName: "Cubby",
        description,
        homepage: "https://github.com/nickysemenza/cubby",
      }),
    },
    ...skills.map((skill) => ({
      path: `plugins/cubby/skills/${skill.name}/SKILL.md`,
      content: `---
name: ${skill.name}
description: ${skill.description}
---

<!-- Generated from ${skill.path} by apps/web/generator/claude-plugin.ts — do not edit. -->

The ${skill.name} playbook lives on the Cubby MCP server so it matches the
deployed app. Call the Cubby connector's \`playbook\` tool with
\`{"action": "get", "name": "${skill.name}"}\` and follow the returned
instructions. Its relative links are repository paths: read the ones a step
needs with \`{"action": "read", "path": "…"}\`, passing a link's \`#anchor\` as
\`heading\`.

If the Cubby connector is not connected, ask the member to connect it
(\`https://cubby.nickysemenza.com/api/mcp\`) before continuing.
`,
    })),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const file of await renderClaudePlugin(root)) {
    await mkdir(dirname(resolve(root, file.path)), { recursive: true });
    await writeFile(resolve(root, file.path), file.content);
  }
}
