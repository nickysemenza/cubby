import { describe, expect, it, vi } from "vitest";
import { observeResponseBody } from "./response-body-observer";

describe("observeResponseBody", () => {
  it("reports completion only after the streamed body closes", async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
      { status: 202, statusText: "Streaming", headers: { "X-Test": "kept" } },
    );
    const observe = vi.fn();
    const times = [10, 25];
    const observedResponse = observeResponseBody(
      response,
      observe,
      () => times.shift() ?? 25,
    );
    const reader = observedResponse.body?.getReader();
    if (!reader || !source) throw new Error("expected stream controllers");

    const firstRead = reader.read();
    source.enqueue(new TextEncoder().encode("first"));
    expect(new TextDecoder().decode((await firstRead).value)).toBe("first");
    expect(observe).not.toHaveBeenCalled();

    const finalRead = reader.read();
    source.close();
    expect(await finalRead).toEqual({ done: true, value: undefined });
    expect(observe).toHaveBeenCalledWith({
      outcome: "complete",
      durationMs: 15,
    });
    expect(observedResponse.status).toBe(202);
    expect(observedResponse.statusText).toBe("Streaming");
    expect(observedResponse.headers.get("x-test")).toBe("kept");
  });

  it("reports cancellation once and forwards it upstream", async () => {
    const cancel = vi.fn();
    const observe = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const reader = observeResponseBody(
      response,
      observe,
      () => 5,
    ).body?.getReader();
    if (!reader) throw new Error("expected response body");

    await reader.cancel("client-left");
    await reader.cancel("duplicate");

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("client-left");
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith({
      outcome: "cancelled",
      durationMs: 0,
    });
  });

  it("does not let an observer failure break body delivery", async () => {
    const response = new Response("healthy");
    const observedResponse = observeResponseBody(response, () => {
      throw new Error("telemetry failed");
    });

    await expect(observedResponse.text()).resolves.toBe("healthy");
  });

  it("reports a source stream error", async () => {
    const observe = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("source failed"));
        },
      }),
    );

    await expect(observeResponseBody(response, observe).text()).rejects.toThrow(
      "source failed",
    );
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error" }),
    );
  });

  it("ends empty responses immediately", () => {
    const observe = vi.fn();
    const response = new Response(null, { status: 204 });

    expect(observeResponseBody(response, observe)).toBe(response);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "empty" }),
    );
  });
});
