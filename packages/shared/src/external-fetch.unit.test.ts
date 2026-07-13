import { describe, expect, it, vi } from "vitest";
import {
  assertResponseContentType,
  fetchExternalResponse,
  readResponseWithLimit,
  sanitizeExternalUrl,
  validateExternalHttpUrl,
} from "./external-fetch";

describe("external fetch policy", () => {
  it.each([
    "ftp://example.com/file",
    "https://user:pass@example.com/file",
    "http://localhost/file",
    "http://foo.local/file",
    "http://127.0.0.1/file",
    "http://169.254.169.254/file",
    "http://10.0.0.1/file",
    "http://192.168.0.1/file",
    "http://[::1]/file",
    "http://[fd00::1]/file",
  ])("rejects %s", (url) => {
    expect(() => validateExternalHttpUrl(url)).toThrow();
  });

  it("strips sensitive URL parts from logs", () => {
    expect(
      sanitizeExternalUrl("https://user:pass@example.com/a?token=secret#x"),
    ).toBe("https://example.com/a");
  });

  it("revalidates redirect targets", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/internal" },
        }),
    );
    await expect(
      fetchExternalResponse("https://example.com/start", { fetcher }),
    ).rejects.toThrow();
  });

  it("follows a bounded public redirect", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    const response = await fetchExternalResponse("https://example.com/start", {
      fetcher,
    });
    expect(await response.text()).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("enforces content type and body limits", async () => {
    const response = new Response("12345", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    expect(assertResponseContentType(response, ["text/html"])).toBe(
      "text/html",
    );
    await expect(readResponseWithLimit(response, 4)).rejects.toThrow();
  });
});
