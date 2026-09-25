import { describe, expect, it } from "vitest";

import { withUnhandledErrorBody } from "./unhandled-error-body";

const genericH3Body = () =>
  Response.json(
    { status: 500, unhandled: true, message: "HTTPError" },
    { status: 500, headers: { "x-request-id": "req-1" } },
  );

describe("withUnhandledErrorBody", () => {
  it("replaces the generic 500 JSON body with the scrubbed thrown error", async () => {
    const error = new Error(
      "runs[0].publicId expected string, got undefined; Authorization: Bearer abc",
    );
    const response = await withUnhandledErrorBody(genericH3Body(), error);

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("req-1");
    const body = await response.json();
    expect(body.error).toBe(
      "Error: runs[0].publicId expected string, got undefined; Authorization: [REDACTED]",
    );
  });

  it("keeps a route's own error body", async () => {
    const own = Response.json({ error: "Upstream said no" }, { status: 502 });
    const response = await withUnhandledErrorBody(own, new Error("other"));
    expect(await response.json()).toEqual({ error: "Upstream said no" });
  });

  it("leaves HTML error pages alone", async () => {
    const html = new Response("<html>boom</html>", {
      status: 500,
      headers: { "content-type": "text/html" },
    });
    const response = await withUnhandledErrorBody(html, new Error("boom"));
    expect(await response.text()).toBe("<html>boom</html>");
  });
});
