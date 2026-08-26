import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScanWorkbench } from "./ScanWorkbench";

vi.mock("~/app/_components/inventory/persistent-scanner", () => ({
  UNIVERSAL_SCAN_FORMATS: ["qr_code", "ean_13"],
  PersistentScanner: ({
    onError,
    onScan,
  }: {
    onError: (message: string) => void;
    onScan: (value: string) => void;
  }) => (
    <>
      <button type="button" onClick={() => onScan("012345678905")}>
        Simulate camera scan
      </button>
      <button type="button" onClick={() => onError("Permission denied")}>
        Deny camera permission
      </button>
    </>
  ),
}));

describe("ScanWorkbench", () => {
  const openManualEntry = () =>
    fireEvent.click(screen.getByRole("button", { name: "Enter code" }));

  it("submits a Cubby label from the manual field", async () => {
    const onResolve = vi.fn(async () => {});
    render(<ScanWorkbench onResolve={onResolve} />);
    openManualEntry();

    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "https://cubby.example.com/LOC-4K7M" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith({
        kind: "shortcode",
        shortcode: "LOC-4K7M",
        type: "location",
      }),
    );
  });

  it("classifies camera product codes and resolves only one at a time", async () => {
    let finish: (() => void) | undefined;
    const onResolve = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ScanWorkbench onResolve={onResolve} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Simulate camera scan" }),
    );
    expect(onResolve).toHaveBeenCalledWith({
      kind: "product",
      code: { kind: "barcode", value: "012345678905" },
    });

    openManualEntry();
    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "978-0-306-40615-7" },
    });
    fireEvent.submit(screen.getByLabelText("Code").closest("form")!);
    expect(onResolve).toHaveBeenCalledTimes(1);

    finish?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open" })).not.toBeDisabled(),
    );
  });

  it("retains manual input and names the recovery after invalid input", () => {
    const onResolve = vi.fn(async () => {});
    render(<ScanWorkbench onResolve={onResolve} />);
    openManualEntry();

    const input = screen.getByLabelText("Code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com/item" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(input.value).toBe("https://example.com/item");
    expect(screen.getByText(/not a Cubby label/)).toBeDefined();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("keeps manual entry usable when camera permission is denied", () => {
    const onResolve = vi.fn(async () => {});
    render(<ScanWorkbench onResolve={onResolve} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Deny camera permission" }),
    );
    openManualEntry();

    const input = screen.getByLabelText("Code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "012345678905" } });

    expect(
      screen.getByText(/Camera unavailable.*Permission denied/),
    ).toBeDefined();
    expect(input.value).toBe("012345678905");
    expect(screen.getByRole("button", { name: "Open" })).not.toBeDisabled();
  });

  it("keeps the code available when product resolution fails", async () => {
    const onResolve = vi.fn(async () => {
      throw new Error("Lookup service is unavailable");
    });
    render(<ScanWorkbench onResolve={onResolve} />);
    openManualEntry();

    const input = screen.getByLabelText("Code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "012345678905" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(screen.getByText(/Lookup service is unavailable/)).toBeDefined(),
    );
    expect(input.value).toBe("012345678905");
  });
});
