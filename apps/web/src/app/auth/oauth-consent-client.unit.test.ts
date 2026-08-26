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
    expect(canAllowConsent(false, VERIFIED, false)).toBe(false);
    expect(canAllowConsent(true, { kind: "loading" }, false)).toBe(false);
    expect(
      canAllowConsent(true, { kind: "invalid", message: "Missing" }, false),
    ).toBe(false);
    expect(
      canAllowConsent(true, { kind: "error", message: "Offline" }, false),
    ).toBe(false);
    expect(canAllowConsent(true, VERIFIED, true)).toBe(false);
    expect(canAllowConsent(true, VERIFIED, false)).toBe(true);
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
});
