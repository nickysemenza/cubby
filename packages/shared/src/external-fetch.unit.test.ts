import { describe, expect, it, vi } from "vitest";
import {
  assertResponseContentType,
  fetchExternalResponse,
  readResponseWithLimit,
  responseBodyWithLimit,
  sanitizeExternalUrl,
  validateExternalHttpUrl,
} from "./external-fetch";

function stalledResponse(onCancel: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: onCancel,
    }),
  );
}

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
    "http://[::ffff:127.0.0.1]/file",
    "http://[fe90::1]/file",
    "http://[fd00::1]/file",
  ])("rejects %s", (url) => {
    // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    expect(() => validateExternalHttpUrl(url)).toThrow();
  });

  it.each([
    "http://8.8.8.8/file",
    "http://[2606:4700:4700::1111]/file",
    "http://[::ffff:8.8.8.8]/file",
  ])("allows public IP address %s", (url) => {
    expect(validateExternalHttpUrl(url).protocol).toBe("http:");
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
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
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
    // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    await expect(readResponseWithLimit(response, 4)).rejects.toThrow();
  });

  it("keeps its deadline through a stalled buffered response body", async () => {
    vi.useFakeTimers();
    try {
      let fetchSignal: AbortSignal | undefined;
      let canceled = false;
      const response = await fetchExternalResponse("https://example.com/file", {
        fetcher: async (_input, init) => {
          fetchSignal = init?.signal ?? undefined;
          return stalledResponse(() => {
            canceled = true;
          });
        },
        timeoutMs: 25,
      });

      const body = readResponseWithLimit(response, 1024);
      await Promise.all([
        expect(body).rejects.toMatchObject({ name: "AbortError" }),
        vi.advanceTimersByTimeAsync(25),
      ]);
      expect(fetchSignal?.aborted).toBe(true);
      expect(canceled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps its deadline through streaming consumption after redirects", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let canceled = false;
      const response = await fetchExternalResponse(
        "https://example.com/start",
        {
          fetcher: async () => {
            calls += 1;
            return calls === 1
              ? new Response(null, {
                  status: 302,
                  headers: { location: "/next" },
                })
              : stalledResponse(() => {
                  canceled = true;
                });
          },
          timeoutMs: 25,
        },
      );

      const reader = responseBodyWithLimit(response, 1024).getReader();
      const chunk = reader.read();
      await Promise.all([
        expect(chunk).rejects.toMatchObject({ name: "AbortError" }),
        vi.advanceTimersByTimeAsync(25),
      ]);
      expect(calls).toBe(2);
      expect(canceled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("composes caller cancellation and clears its deadline after body completion", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      let canceled = false;
      const response = await fetchExternalResponse("https://example.com/file", {
        fetcher: async () =>
          stalledResponse(() => {
            canceled = true;
          }),
        signal: caller.signal,
        timeoutMs: 25,
      });

      const body = response.text();
      caller.abort();
      await expect(body).rejects.toMatchObject({ name: "AbortError" });
      expect(canceled).toBe(true);

      const completed = await fetchExternalResponse("https://example.com/ok", {
        fetcher: async () => new Response("ok"),
        timeoutMs: 25,
      });
      await expect(completed.text()).resolves.toBe("ok");
      await vi.advanceTimersByTimeAsync(25);
    } finally {
      vi.useRealTimers();
    }
  });
});
