import { describe, expect, it } from "vitest";

import {
  canExportLabels,
  shouldMountLabelPrintPortal,
} from "./label-export-state";

describe("label export state", () => {
  it("fails closed when one lookup fails after another returned items", () => {
    const error = new Error("Product lookup failed");

    expect(
      canExportLabels({
        error,
        itemCount: 2,
        qrReady: true,
        sheetFormat: true,
      }),
    ).toBe(false);
    expect(
      canExportLabels({
        error,
        itemCount: 2,
        qrReady: true,
        sheetFormat: false,
      }),
    ).toBe(false);
    expect(
      shouldMountLabelPrintPortal({
        error,
        isLoading: false,
        sheetFormat: true,
      }),
    ).toBe(false);
  });

  it("exports only complete ready output", () => {
    expect(
      canExportLabels({
        error: null,
        itemCount: 2,
        qrReady: true,
        sheetFormat: true,
      }),
    ).toBe(true);
    expect(
      shouldMountLabelPrintPortal({
        error: null,
        isLoading: false,
        sheetFormat: true,
      }),
    ).toBe(true);
  });
});
