import { afterEach, describe, expect, it, vi } from "vitest";

import { PresignedUploadError, putPresignedObject } from "./presigned-upload";

describe("putPresignedObject", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws PresignedUploadError with status and body text on a non-ok response", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response("Access Denied", {
          status: 403,
          statusText: "Forbidden",
        }),
      ),
    );

    const body = new Blob(["hello"]);
    await expect(
      putPresignedObject("https://r2.example/upload-url", body, "image/png"),
    ).rejects.toMatchObject({
      name: "PresignedUploadError",
      status: 403,
      detail: "Access Denied",
    });
  });

  it("falls back to a placeholder detail when the error body can't be read", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("stream broken"));
            },
          }),
          { status: 500 },
        ),
      ),
    );

    const body = new Blob(["hello"]);
    let caught: unknown;
    try {
      await putPresignedObject(
        "https://r2.example/upload-url",
        body,
        "image/png",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PresignedUploadError);
    expect((caught as PresignedUploadError).status).toBe(500);
    expect((caught as PresignedUploadError).detail).toBe("Unknown error");
  });

  it("forwards an AbortSignal to fetch", async () => {
    const sent: RequestInit[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      if (init) sent.push(init);
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const controller = new AbortController();

    await putPresignedObject(
      "https://r2.example/upload-url",
      new Blob(["x"]),
      "application/pdf",
      { signal: controller.signal },
    );

    expect(sent[0]?.signal).toBe(controller.signal);
  });
});
