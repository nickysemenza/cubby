import { describe, expect, it } from "vitest";

import {
  buildConfidentOwnershipIntervals,
  classifyProductMovement,
  clipOwnershipIntervals,
} from "./product-movement";

describe("classifyProductMovement", () => {
  it("uses money direction first and a zero-cost quantity sign as the fact", () => {
    expect(classifyProductMovement(12, -3)).toEqual({
      kind: "acquired",
      signedQuantity: 3,
    });
    expect(classifyProductMovement(-12, 3)).toEqual({
      kind: "exited",
      signedQuantity: -3,
    });
    expect(classifyProductMovement(0, 1)).toEqual({
      kind: "acquired",
      signedQuantity: 1,
    });
    expect(classifyProductMovement(0, -1)).toEqual({
      kind: "discarded",
      signedQuantity: -1,
    });
    expect(classifyProductMovement(null, 2)).toEqual({
      kind: "acquired",
      signedQuantity: 2,
    });
    expect(classifyProductMovement(null, -2)).toEqual({
      kind: "exited",
      signedQuantity: -2,
    });
    expect(classifyProductMovement(null, null)).toEqual({
      kind: "unknown",
      signedQuantity: null,
    });
  });
});

describe("buildConfidentOwnershipIntervals", () => {
  it("opens, closes, and reopens ownership until an unknown quantity ends confidence", () => {
    expect(
      buildConfidentOwnershipIntervals(
        [
          { date: "2020-01-01", signedQuantity: 2 },
          { date: "2021-01-01", signedQuantity: -1 },
          { date: "2022-01-01", signedQuantity: -1 },
          { date: "2023-01-01", signedQuantity: 1 },
          { date: "2024-01-01", signedQuantity: null },
          { date: "2025-01-01", signedQuantity: -1 },
        ],
        "2026-08-11",
      ),
    ).toEqual({
      intervals: [
        { start: "2020-01-01", end: "2022-01-01" },
        { start: "2023-01-01", end: "2024-01-01" },
      ],
      confidenceLostAt: "2024-01-01",
    });
  });

  it("stops interval inference when a movement would create a negative balance", () => {
    expect(
      buildConfidentOwnershipIntervals(
        [
          { date: "2020-01-01", signedQuantity: 1 },
          { date: "2021-01-01", signedQuantity: -2 },
          { date: "2022-01-01", signedQuantity: 3 },
        ],
        "2026-08-11",
      ),
    ).toEqual({
      intervals: [{ start: "2020-01-01", end: "2021-01-01" }],
      confidenceLostAt: "2021-01-01",
    });
  });

  it("combines same-day quantities so row order cannot fabricate uncertainty", () => {
    expect(
      buildConfidentOwnershipIntervals(
        [
          { date: "2020-01-01", signedQuantity: -1 },
          { date: "2020-01-01", signedQuantity: 1 },
          { date: "2021-01-01", signedQuantity: 1 },
        ],
        "2022-01-01",
      ),
    ).toEqual({
      intervals: [{ start: "2021-01-01", end: "2022-01-01" }],
      confidenceLostAt: null,
    });
  });
});

describe("clipOwnershipIntervals", () => {
  it("clips intersecting intervals to the movement window and drops the rest", () => {
    expect(
      clipOwnershipIntervals(
        [
          { start: "2019-01-01", end: "2021-01-01" },
          { start: "2022-01-01", end: "2023-01-01" },
          { start: "2025-01-01", end: "2026-01-01" },
        ],
        "2020-01-01",
        "2024-01-01",
      ),
    ).toEqual([
      { start: "2020-01-01", end: "2021-01-01" },
      { start: "2022-01-01", end: "2023-01-01" },
    ]);
  });
});
