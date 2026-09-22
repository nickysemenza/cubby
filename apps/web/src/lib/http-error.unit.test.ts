import { describe, expect, it } from "vitest";
import { z } from "zod";

import { errorDiagnosticsSchema } from "./error-diagnostics";
import { getAppErrorDetails } from "./error-utils";
import {
  HttpResponseError,
  readJsonOrThrow,
  throwHttpError,
} from "./http-error";

/** Runs `thunk` and returns the `HttpResponseError` it rejects with — an
 * `instanceof` narrow instead of an `as` cast, and re-throws anything else
 * so a genuine assertion failure inside `thunk` still fails the test. */
async function captureHttpResponseError(
  thunk: () => Promise<never>,
): Promise<HttpResponseError> {
  try {
    await thunk();
  } catch (error) {
    if (error instanceof HttpResponseError) return error;
    throw error;
  }
  throw new Error("Expected thunk to reject with an HttpResponseError");
}

describe("throwHttpError", () => {
  it.each([
    [
      "a JSON { error } body",
      new Response(JSON.stringify({ error: "Vendor account is locked" }), {
        status: 409,
        headers: { "x-request-id": "req-409" },
      }),
      "Vendor account is locked",
    ],
    [
      "a non-JSON HTML body",
      new Response("<html><body>Gateway Timeout</body></html>", {
        status: 504,
        headers: { "x-request-id": "req-504" },
      }),
      "Could not load (504)",
    ],
    [
      "an empty body",
      new Response("", {
        status: 500,
        headers: { "x-request-id": "req-500" },
      }),
      "Could not load (500)",
    ],
  ])("carries the status and body text for %s", async (_label, response) => {
    const error = await captureHttpResponseError(() =>
      throwHttpError(response, "Could not load"),
    );

    const detail = getAppErrorDetails(error);
    expect(detail.requestId).toBe(response.headers.get("x-request-id"));
    expect(
      errorDiagnosticsSchema.safeParse(error.data.diagnostics).success,
    ).toBe(true);
    expect(error.data.diagnostics.causes[0]?.status).toBe(response.status);
  });

  it("uses the server-provided error string as the message", async () => {
    const response = new Response(
      JSON.stringify({ error: "Vendor account is locked" }),
      { status: 409 },
    );
    const error = await captureHttpResponseError(() =>
      throwHttpError(response, "Could not load"),
    );
    expect(error.message).toBe("Vendor account is locked");
  });

  it("falls back to the fallback message plus status when the body has no error field", async () => {
    const response = new Response("<html>nope</html>", { status: 504 });
    const error = await captureHttpResponseError(() =>
      throwHttpError(response, "Could not load"),
    );
    expect(error.message).toBe("Could not load (504)");
    expect(error.data.diagnostics.causes[0]?.message).toBe("<html>nope</html>");
    expect(error.data.code).toBe("HTTP_504");
  });

  it("omits requestId when the response carries no x-request-id header", async () => {
    const response = new Response("", { status: 500 });
    const error = await captureHttpResponseError(() =>
      throwHttpError(response, "Could not load"),
    );
    expect(error.data.requestId).toBeUndefined();
  });

  it("puts the request method into diagnostics.operation when given", async () => {
    const response = new Response("", { status: 500 });
    const error = await captureHttpResponseError(() =>
      throwHttpError(response, "Could not load", { method: "POST" }),
    );
    expect(error.data.diagnostics.operation.startsWith("POST ")).toBe(true);
  });
});

describe("readJsonOrThrow", () => {
  it("parses the body through the schema on success", async () => {
    const response = Response.json({ ok: true });
    await expect(
      readJsonOrThrow(
        response,
        z.object({ ok: z.boolean() }),
        "Could not load",
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("throws HttpResponseError instead of parsing on a non-ok response", async () => {
    const response = new Response(JSON.stringify({ error: "Nope" }), {
      status: 400,
    });
    await expect(
      readJsonOrThrow(
        response,
        z.object({ ok: z.boolean() }),
        "Could not load",
      ),
    ).rejects.toBeInstanceOf(HttpResponseError);
  });
});
