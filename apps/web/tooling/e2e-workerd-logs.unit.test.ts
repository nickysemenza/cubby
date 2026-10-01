import { describe, expect, it } from "vitest";

import { harnessExplorerUrl, sanitizeWorkerdLogs } from "./e2e-workerd-logs";

describe("workerd log attachments", () => {
  // Run bundles are uploaded from CI, so a credential-shaped value in a
  // Worker log line must not survive into the attachment.
  it("redacts credential-shaped values and keeps level and timestamp", () => {
    const [log] = sanitizeWorkerdLogs([
      {
        timestamp: 1,
        level: "error",
        message:
          "connect postgresql://postgres:hunter2@localhost:5432/cubby failed; Authorization: Bearer abc.def",
      },
    ]);
    expect(log).toMatchObject({ timestamp: 1, level: "error" });
    expect(log?.message).not.toContain("hunter2");
    expect(log?.message).not.toContain("abc.def");
  });

  it("points at the harness's local explorer", () => {
    expect(harnessExplorerUrl("http://localhost:8787")).toBe(
      "http://localhost:8787/cdn-cgi/local/explorer",
    );
  });
});
