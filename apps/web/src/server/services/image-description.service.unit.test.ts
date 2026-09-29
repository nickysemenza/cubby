import { describe, expect, it } from "vitest";

import { fetchAnalysisRendition } from "./image-description.service";

const RENDITION_URL =
  "https://images.example.com/cdn-cgi/image/width=2048,format=jpeg/a.jpg";

const respondWith = (response: Response) => async () => response;

describe("fetchAnalysisRendition", () => {
  it("reports the raw status and body snippet of a failed rendition", async () => {
    const body = `Error 9401: rendition unavailable ${"x".repeat(2_000)}`;
    const failure = () =>
      fetchAnalysisRendition(
        RENDITION_URL,
        respondWith(new Response(body, { status: 502 })),
      );

    await expect(failure()).rejects.toThrow(
      /HTTP 502.*Error 9401: rendition unavailable/,
    );
    // A snippet, not the whole error page.
    await expect(failure()).rejects.not.toThrow("x".repeat(600));
  });

  it("returns the body bytes of a successful rendition", async () => {
    const bytes = await fetchAnalysisRendition(
      RENDITION_URL,
      respondWith(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});
