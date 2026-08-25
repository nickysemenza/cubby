import { describe, expect, it } from "vitest";
import { withHtmlNoCache, withRequestId } from "./http-cache";

describe("withHtmlNoCache", () => {
  it("decorates HTML while preserving the streamed response metadata", async () => {
    const response = new Response("<html>healthy</html>", {
      status: 202,
      statusText: "Rendered",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "session=abc; HttpOnly",
        "X-Cubby": "preserved",
      },
    });

    const decorated = withHtmlNoCache(response);

    expect(decorated.status).toBe(202);
    expect(decorated.statusText).toBe("Rendered");
    expect(decorated.headers.get("cache-control")).toBe(
      "private, no-cache, must-revalidate",
    );
    expect(decorated.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(decorated.headers.get("set-cookie")).toBe("session=abc; HttpOnly");
    expect(decorated.headers.get("x-cubby")).toBe("preserved");
    expect(await decorated.text()).toBe("<html>healthy</html>");
  });

  it("returns non-HTML responses unchanged", () => {
    const response = Response.json({ ok: true }, { status: 201 });
    expect(withHtmlNoCache(response)).toBe(response);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("adds a correlation id to a non-HTML server-function response", async () => {
    const response = Response.json({ ok: true }, { status: 201 });
    const decorated = withRequestId(response, "ray-start-test");

    expect(decorated).not.toBe(response);
    expect(decorated.headers.get("x-trace-id")).toBe("ray-start-test");
    expect(await decorated.json()).toEqual({ ok: true });
  });
});
