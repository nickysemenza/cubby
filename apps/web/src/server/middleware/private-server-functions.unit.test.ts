import { describe, expect, it } from "vitest";
import { privateServerFunctionResponse } from "./private-server-functions";

describe("privateServerFunctionResponse", () => {
  it("marks Start function responses private and varies on actor credentials", () => {
    const response = privateServerFunctionResponse(
      "serverFn",
      new Response("ok", { headers: { Vary: "Accept-Encoding" } }),
    );

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
  });

  it("stamps the request correlation id on a Start response", () => {
    const response = privateServerFunctionResponse(
      "serverFn",
      new Response("ok"),
      "ray-start-test",
    );

    expect(response.headers.get("x-trace-id")).toBe("ray-start-test");
  });

  it("leaves routes and SSR responses unchanged", () => {
    const response = new Response("ok", {
      headers: { "Cache-Control": "public, max-age=60" },
    });
    expect(privateServerFunctionResponse("router", response)).toBe(response);
  });
});
