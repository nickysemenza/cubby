import { toPublicImpact } from "@cubby/schemas/entity-integrity";
import { describe, expect, it } from "vitest";

import {
  createAppError,
  createBlockedError,
  isBlockedRefusal,
  toPublicErrorPayload,
} from "./app-error";

const BLOCKED_PRODUCT = "PRD-4K7M";

const codedError = (options: {
  code: string;
  message: string;
  cause?: unknown;
}) =>
  Object.assign(new Error(options.message, { cause: options.cause }), {
    code: options.code,
  });

const inventoryBlocker = toPublicImpact(
  {
    code: "block-live-inventory",
    effect: "block",
    label: "inventory entries",
    description: "Live inventory still references this product.",
    total: 2,
    byTargetId: { "00000000-0000-0000-0000-000000000001": 2 },
  },
  new Map([["00000000-0000-0000-0000-000000000001", BLOCKED_PRODUCT]]),
  "drop",
);

describe("toPublicErrorPayload", () => {
  it("lifts code, reason and blockers off a blocked refusal", () => {
    const payload = toPublicErrorPayload(
      createBlockedError(
        "PRODUCT_HAS_INVENTORY",
        "Cannot delete a product while inventory references it.",
        [inventoryBlocker],
      ),
    );

    expect(payload).toEqual({
      code: "PRECONDITION_FAILED",
      reason: "PRODUCT_HAS_INVENTORY",
      blockers: [inventoryBlocker],
    });
    // Keyed by shortcode, never uuid — the branded parse is what enforces it.
    expect(Object.keys(payload.blockers?.[0]?.byTargetId ?? {})).toEqual([
      BLOCKED_PRODUCT,
    ]);
  });

  it("carries code and reason for a plain app error, with no blockers key", () => {
    expect(
      toPublicErrorPayload(createAppError("PRODUCT_NOT_FOUND", "no such row")),
    ).toEqual({ code: "NOT_FOUND", reason: "PRODUCT_NOT_FOUND" });
  });

  it("keeps a reason that is not an AppErrorReason", () => {
    // `INVALID_INPUT` is minted at the MCP boundary for a wrong-prefix
    // shortcode and is absent from `AppErrors`. The MCP-side whitelist used to
    // narrow it away, which dropped the most common caller-fixable fault.
    expect(
      toPublicErrorPayload(
        codedError({
          code: "BAD_REQUEST",
          message: "Not location shortcodes: PRD-4K7M",
          cause: { reason: "INVALID_INPUT" },
        }),
      ).reason,
    ).toBe("INVALID_INPUT");
  });

  it("drops a malformed blockers payload rather than passing it through", () => {
    expect(
      toPublicErrorPayload(
        codedError({
          code: "PRECONDITION_FAILED",
          message: "blocked",
          cause: { reason: "PRODUCT_HAS_INVENTORY", blockers: [{ nope: 1 }] },
        }),
      ).blockers,
    ).toBeUndefined();
  });

  it("survives a non-Error throw and an error with no cause", () => {
    expect(toPublicErrorPayload("boom")).toEqual({});
    expect(toPublicErrorPayload(new Error("boom"))).toEqual({});
  });
});

describe("isBlockedRefusal", () => {
  it("recognizes both vintages of guard", () => {
    // Attributed: `createBlockedError` names the rows.
    expect(
      isBlockedRefusal(
        createBlockedError("PRODUCT_HAS_INVENTORY", "blocked", [
          inventoryBlocker,
        ]),
      ),
    ).toBe(true);
    // Unattributed: the older `createAppError` guards say it with the code.
    expect(
      isBlockedRefusal(createAppError("PROJECT_HAS_TASKS", "blocked")),
    ).toBe(true);
  });

  it("is false for a genuine fault", () => {
    expect(isBlockedRefusal(createAppError("PRODUCT_NOT_FOUND", "gone"))).toBe(
      false,
    );
    expect(
      isBlockedRefusal(
        codedError({
          code: "BAD_REQUEST",
          message: "bad shortcode",
          cause: { reason: "INVALID_INPUT" },
        }),
      ),
    ).toBe(false);
    expect(isBlockedRefusal(new Error("boom"))).toBe(false);
  });
});
