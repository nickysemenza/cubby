import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("MCP cached-read allowlist", () => {
  it("keeps distinct strong and bounded-stale callers at the route seam", () => {
    const route = read("../routes/api/mcp.ts");

    expect(route).toContain("const caller = createMcpWorkflowCaller(ctx)");
    expect(route).toContain("readDb: boundedStaleDb");
    expect(route).toContain("readCaller,");
    expect(route).toContain("entityKernel: {");
    expect(route).toContain("db: ctx.db");
  });

  it("uses the bounded-stale caller only for public search tools", () => {
    const searchTools = read("./mcp/tools/search.tools.ts");
    const dataQualityTools = read("./mcp/tools/data-quality.tools.ts");
    const registration = read("./mcp/tools/tool-registration.ts");

    expect(searchTools).toContain("getReadCaller(extra)");
    expect(searchTools).not.toContain("getCaller(extra)");
    expect(dataQualityTools).toContain("getCaller(extra)");
    expect(dataQualityTools).not.toContain("getReadCaller(extra)");
    expect(registration).toContain(
      'callerFromExtra(extra, "readCaller") ?? getCaller(extra)',
    );
  });
});
