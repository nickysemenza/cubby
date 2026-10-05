import { importRunAgentManifest } from "@cubby/schemas/import-run-agent";
import { describe, expect, it } from "vitest";

import { purchaseAgentToolCatalog } from "./agent-tool-catalog";
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

  // The agent mounts this catalog without listing tools; each mounted tool
  // advertises only the purpose's actions.
  it("mounts each purpose's tools narrowed to its actions", () => {
    const { mcpActions, mcpTools } = importRunAgentManifest.photo_inventory;
    const catalog = purchaseAgentToolCatalog("photo_inventory");
    expect(catalog.map((tool) => tool.name).sort()).toEqual(
      [...mcpTools].sort(),
    );
    const imports = catalog.find((tool) => tool.name === "imports_read");
    const allowed = mcpActions.flatMap((action) =>
      action.startsWith("imports_read.") ? [action.slice(13)] : [],
    );
    for (const action of allowed)
      expect(imports?.description).toContain(`- ${action}:`);
    expect(imports?.description).not.toContain("- purchase_status:");
  });
});
