import { describe, expect, it } from "vitest";

import { isMaintenanceMode, maintenanceResponse } from "./maintenance";

describe("maintenance mode", () => {
  it("is on only for the exact secret value", () => {
    expect(isMaintenanceMode({ MAINTENANCE_MODE: "true" })).toBe(true);
    expect(isMaintenanceMode({ MAINTENANCE_MODE: "false" })).toBe(false);
    expect(isMaintenanceMode({})).toBe(false);
  });

  it("answers API and MCP callers with a structured 503", async () => {
    for (const path of ["/api/v1/products", "/_serverFn/abc", "/mcp"]) {
      const response = maintenanceResponse(
        new Request(`https://cubby.test${path}`),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("300");
      expect(await response.json()).toMatchObject({
        error: { code: "MAINTENANCE" },
      });
    }
  });

  it("answers browsers with a page", async () => {
    const response = maintenanceResponse(
      new Request("https://cubby.test/products"),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
