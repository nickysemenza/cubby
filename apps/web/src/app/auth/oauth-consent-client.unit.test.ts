import { describe, expect, it, vi } from "vitest";

import {
  canAllowConsent,
  type PublicClientLookupState,
  verifyPublicClient,
} from "./oauth-consent-client";

const VERIFIED: PublicClientLookupState = {
  kind: "verified",
  client: { client_id: "client-1", client_name: "Cubby Connector" },
};

describe("OAuth consent client verification", () => {
  it("only allows approval after hydrated, verified client metadata", () => {
    expect(canAllowConsent(false, "client-1", VERIFIED, false)).toBe(false);
    expect(canAllowConsent(true, "client-1", { kind: "loading" }, false)).toBe(
      false,
    );
    expect(
      canAllowConsent(
        true,
        "client-1",
        { kind: "invalid", message: "Missing" },
        false,
      ),
    ).toBe(false);
    expect(
      canAllowConsent(
        true,
        "client-1",
        { kind: "error", message: "Offline", detail: "network down" },
        false,
      ),
    ).toBe(false);
    expect(canAllowConsent(true, "client-1", VERIFIED, true)).toBe(false);
    expect(canAllowConsent(true, "client-2", VERIFIED, false)).toBe(false);
    expect(canAllowConsent(true, "client-1", VERIFIED, false)).toBe(true);
  });

  it("distinguishes a missing or removed client from a retryable lookup failure", async () => {
    const lookup = vi.fn();

    await expect(verifyPublicClient(undefined, lookup)).resolves.toMatchObject({
      kind: "invalid",
    });
    expect(lookup).not.toHaveBeenCalled();

    lookup.mockResolvedValueOnce({ data: null });
    await expect(
      verifyPublicClient("removed-client", lookup),
    ).resolves.toMatchObject({
      kind: "invalid",
    });

    lookup.mockRejectedValueOnce(new Error("network down"));
    await expect(verifyPublicClient("client-1", lookup)).resolves.toMatchObject(
      {
        kind: "error",
        detail: "network down",
      },
    );

    lookup.mockResolvedValueOnce({ error: { message: "upstream 503" } });
    await expect(verifyPublicClient("client-1", lookup)).resolves.toMatchObject(
      {
        kind: "error",
        detail: "upstream 503",
      },
    );
  });

  it("recovers to verified metadata on a later retry", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ data: VERIFIED.client });

    await expect(verifyPublicClient("client-1", lookup)).resolves.toMatchObject(
      {
        kind: "error",
      },
    );
    await expect(verifyPublicClient("client-1", lookup)).resolves.toEqual(
      VERIFIED,
    );
  });

  it("rejects metadata returned for a different requested client", async () => {
    const lookup = vi.fn().mockResolvedValue({ data: VERIFIED.client });

    await expect(verifyPublicClient("client-2", lookup)).resolves.toMatchObject(
      { kind: "error" },
    );
    expect(canAllowConsent(true, "client-2", VERIFIED, false)).toBe(false);
  });
});
