import { afterEach, describe, expect, it, vi } from "vitest";

import { PresignedUploadError, putPresignedObject } from "./presigned-upload";

describe("putPresignedObject", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs the body with exactly the declared content type, not any type on the body itself", async () => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    // A Blob carrying its own (different) type — the declared contentType
    // argument must win. This is the regression: four call sites were
    // forwarding `file.type` instead of the validated content type.
    const body = new Blob(["hello"], { type: "text/plain" });

    await putPresignedObject(
      "https://r2.example/upload-url",
      body,
      "image/png",
    );

    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe("https://r2.example/upload-url");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(body);
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("image/png");
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
    // SAFETY: the toBeInstanceOf assertion above just confirmed the type.
    expect((caught as PresignedUploadError).status).toBe(500);
    // SAFETY: the toBeInstanceOf assertion above just confirmed the type.
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
