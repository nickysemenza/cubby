import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  PersistentScannerPort,
  PersistentScannerProps,
} from "~/app/_components/inventory/persistent-scanner";
import type { ResolvedScanCode } from "~/lib/scan-code";

import { ScanWorkbench } from "./ScanWorkbench";

const scanner: PersistentScannerPort = {
  Scanner: ({ onError, onScan }: PersistentScannerProps) => (
    <>
      <button type="button" onClick={() => onScan("012345678905")}>
        Simulate camera scan
      </button>
      <button type="button" onClick={() => onError?.("Permission denied")}>
        Deny camera permission
      </button>
    </>
  ),
  formats: ["qr_code", "ean_13"],
};

function renderScanWorkbench(
  onResolve: (value: ResolvedScanCode) => Promise<void>,
) {
  return render(<ScanWorkbench onResolve={onResolve} scanner={scanner} />);
}

function openManualEntry() {
  fireEvent.click(screen.getByRole("button", { name: "Enter code" }));
}

describe("ScanWorkbench", () => {
  it("submits a Cubby label from the manual field", async () => {
    const requests: ResolvedScanCode[] = [];
    renderScanWorkbench(async (value) => {
      requests.push(value);
    });
    openManualEntry();

    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "https://cubby.example.com/LOC-4K7M" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(requests).toEqual([
        { kind: "shortcode", shortcode: "LOC-4K7M", type: "location" },
      ]),
    );
  });

  it("classifies camera product codes and resolves only one at a time", async () => {
    const requests: ResolvedScanCode[] = [];
    let finish: (() => void) | undefined;
    renderScanWorkbench(
      async (value) =>
        await new Promise<void>((resolve) => {
          requests.push(value);
          finish = resolve;
        }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Simulate camera scan" }),
    );
    expect(requests).toEqual([
      { kind: "product", code: { kind: "barcode", value: "012345678905" } },
    ]);

    openManualEntry();
    const input = screen.getByLabelText("Code");
    fireEvent.change(input, { target: { value: "978-0-306-40615-7" } });
    const form = input.closest("form");
    if (!form) throw new Error("Manual code field must be inside its form.");
    fireEvent.submit(form);
    expect(requests).toHaveLength(1);

    if (!finish) throw new Error("The scan resolver did not start.");
    finish();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open" })).not.toBeDisabled(),
    );
  });

  it("retains manual input and names the recovery after invalid input", () => {
    renderScanWorkbench(async () => undefined);
    openManualEntry();

    const input = screen.getByLabelText("Code");
    fireEvent.change(input, { target: { value: "https://example.com/item" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(input).toHaveValue("https://example.com/item");
    expect(screen.getByText(/not a Cubby label/)).toBeInTheDocument();
  });

  it("keeps manual entry usable when camera permission is denied", () => {
    renderScanWorkbench(async () => undefined);
    fireEvent.click(
      screen.getByRole("button", { name: "Deny camera permission" }),
    );
    openManualEntry();

    const input = screen.getByLabelText("Code");
    fireEvent.change(input, { target: { value: "012345678905" } });

    expect(
      screen.getByText(/Camera unavailable.*Permission denied/),
    ).toBeInTheDocument();
    expect(input).toHaveValue("012345678905");
    expect(screen.getByRole("button", { name: "Open" })).not.toBeDisabled();
  });

  it("keeps the code available when product resolution fails", async () => {
    renderScanWorkbench(async () => {
      throw new Error("Lookup service is unavailable");
    });
    openManualEntry();

    const input = screen.getByLabelText("Code");
    fireEvent.change(input, { target: { value: "012345678905" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Lookup service is unavailable/),
      ).toBeInTheDocument(),
    );
    expect(input).toHaveValue("012345678905");
  });
});
