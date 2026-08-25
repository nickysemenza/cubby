import { describe, expect, it, vi } from "vitest";
import {
  fetchAndRecordRequestId,
  getLastRequestId,
  REQUEST_ID_HEADER,
} from "./request-id";

describe("fetchAndRecordRequestId", () => {
  it("preserves the response while retaining its correlation id", async () => {
    const response = new Response("ok", {
      headers: { [REQUEST_ID_HEADER]: "ray-start-test" },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);

    await expect(
      fetchAndRecordRequestId(fetch, "/_serverFn/test"),
    ).resolves.toBe(response);
    expect(getLastRequestId()).toBe("ray-start-test");
  });
});
