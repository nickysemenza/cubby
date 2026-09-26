import { importRunAgentManifest } from "@cubby/schemas/import-run-agent";
import { describe, expect, it } from "vitest";

import { listMcpToolCatalog } from "./server";

// The purchase agent mounts only its manifest's MCP tools. A renamed or removed
// tool would silently disappear from an agent run, so every name must stay
// registered on the live catalog.
describe("import run agent manifest", () => {
  it("names only registered MCP tools", async () => {
    const registered = new Set(
      (await listMcpToolCatalog()).tools.map((tool) => tool.name),
    );
    const missing = Object.entries(importRunAgentManifest).flatMap(
      ([purpose, config]) =>
        config.mcpTools
          .filter((name) => !registered.has(name))
          .map((name) => `${purpose}: ${name}`),
    );
    expect(missing).toEqual([]);
  });
});
