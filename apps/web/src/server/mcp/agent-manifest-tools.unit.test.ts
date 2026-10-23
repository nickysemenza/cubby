import { importRunAgentManifest } from "@cubby/schemas/import-run-agent";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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

  // Regression: entity_read's per-kind list filters were 134 KB of the Mail
  // import coordinator's ~61k-token tool schemas, resent on every call; the
  // curated filters (2026-10) took its schema from 39 KB to ~6 KB.
  it("narrows entity_read to the purpose's entity kinds for the agent only", async () => {
    const kinds = Object.keys(
      importRunAgentManifest.mail_import.entityRead.filters,
    );
    const agent = purchaseAgentToolCatalog("mail_import").find(
      (tool) => tool.name === "entity_read",
    );
    const schema = JSON.stringify(agent?.inputSchema);
    expect(schema.length).toBeLessThan(12_000);
    const entity = JSON.parse(schema).properties.entity.enum;
    expect([...entity].sort()).toEqual([...kinds].sort());
    expect(schema).not.toContain("entity=recipe");
    const member = (await listMcpToolCatalog()).tools.find(
      (tool) => tool.name === "entity_read",
    );
    expect(JSON.stringify(member?.inputSchema)).toContain("entity=recipe");
  });

  // The coordinator resends every mounted schema on each model call. Failure
  // modes: a curated filter renamed in the declarations silently vanishes
  // from the agent; the agent's copy keeps unused list inputs, unreachable
  // definitions or a `_runExecution` envelope no mounted action reads; the
  // narrowing leaks into the member catalog.
  it("advertises Mail import's curated entity_read view to the agent only", async () => {
    const view = importRunAgentManifest.mail_import.entityRead;
    const member = (await listMcpToolCatalog()).tools.find(
      (tool) => tool.name === "entity_read",
    );
    const agent = purchaseAgentToolCatalog("mail_import").find(
      (tool) => tool.name === "entity_read",
    );
    const branches = (schema: unknown) =>
      z
        .object({
          properties: z.object({
            filters: z.object({
              anyOf: z.array(
                z.object({
                  description: z.string(),
                  allOf: z.array(
                    z.object({ properties: z.record(z.string(), z.unknown()) }),
                  ),
                }),
              ),
            }),
          }),
        })
        .parse(schema)
        .properties.filters.anyOf.map((branch) => ({
          kind: /entity=(\w+)/u.exec(branch.description)?.[1],
          keys: branch.allOf.flatMap((part) => Object.keys(part.properties)),
        }));
    const memberKeys = new Map(
      branches(member?.inputSchema).map((branch) => [branch.kind, branch.keys]),
    );
    for (const { kind, keys } of branches(agent?.inputSchema)) {
      const curated: readonly string[] =
        view.filters[kind as keyof typeof view.filters];
      expect([...keys].sort(), `${kind} filters`).toEqual([...curated].sort());
      for (const key of curated)
        expect(memberKeys.get(kind), `${kind}.${key}`).toContain(key);
    }
    const properties = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(agent?.inputSchema).properties;
    const memberProperties = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(member?.inputSchema).properties;
    for (const name of [...view.omit, "_runExecution"]) {
      expect(properties).not.toHaveProperty(name);
      expect(memberProperties).toHaveProperty(name);
    }
    const text = JSON.stringify(agent?.inputSchema);
    const definitions = Object.keys(
      z
        .object({ definitions: z.record(z.string(), z.unknown()).default({}) })
        .parse(agent?.inputSchema).definitions,
    );
    expect(
      definitions.filter((name) => !text.includes(`"#/definitions/${name}"`)),
    ).toEqual([]);
    // Declaration notes about kinds the agent cannot read are dropped.
    const kinds = new Set(memberKeys.keys());
    const [declaration = ""] = (agent?.description ?? "").split("\n\n");
    const notedKinds = declaration.split(/(?<=\.) /u).flatMap((sentence) => {
      const word = /^\w+/u.exec(sentence)?.[0] ?? "";
      const kind = word.charAt(0).toLowerCase() + word.slice(1);
      return kinds.has(kind) ? [kind] : [];
    });
    expect(
      notedKinds.filter((kind) => !Object.hasOwn(view.filters, kind)),
    ).toEqual([]);
  });

  it("keeps `_runExecution` only on agent tools whose actions read it", () => {
    for (const purpose of ["mail_import", "photo_inventory"] as const) {
      const catalog = purchaseAgentToolCatalog(purpose);
      const envelope = new Set(
        catalog
          .filter((tool) =>
            Object.hasOwn(
              z
                .object({ properties: z.record(z.string(), z.unknown()) })
                .parse(tool.inputSchema).properties,
              "_runExecution",
            ),
          )
          .map((tool) => tool.name),
      );
      // Import writers take the envelope; the photo agent's entity.update
      // runs through the adapter's replay wrapper, which requires it.
      const readers =
        purpose === "mail_import"
          ? ["purchase_import", "finance", "shipments"]
          : ["entity", "photo_run"];
      for (const tool of catalog)
        expect(envelope.has(tool.name), `${purpose} ${tool.name}`).toBe(
          readers.includes(tool.name),
        );
    }
  });
});
