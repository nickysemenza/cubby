import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import {
  CLOUDFLARE_OBSERVABILITY_URL,
  sentryEventUrl,
} from "~/lib/error-diagnostics";

import { errorToastId, showErrorToast } from "./error-details";
import { ErrorDetailsDialogHost } from "./error-details-dialog";
import {
  closeErrorDetailsDialog,
  getErrorDetailsDialogSnapshot,
  openErrorDetailsDialog,
} from "./error-details-store";
import { ErrorDisplay } from "./error-display";

const makeError = (overrides?: { code?: string }) =>
  new StartOperationError({
    code: overrides?.code ?? "INTERNAL_SERVER_ERROR",
    message: "Connection limit exceeded",
    requestId: "sample-ray",
    diagnostics: {
      origin: "server",
      operation: "entity.list",
      entity: "product",
      stage: "run",
      causes: [
        {
          name: "DatabaseError",
          message: "Connection limit exceeded",
          code: "53300",
        },
      ],
      sentryEventId: "sample-event",
      sentryUrl: sentryEventUrl("sample-event"),
      cfRayId: "sample-ray",
      cloudflareUrl: CLOUDFLARE_OBSERVABILITY_URL,
    },
  });

afterEach(() => {
  closeErrorDetailsDialog();
  vi.restoreAllMocks();
});

describe("error details", () => {
  it("shows the cause, keeps details collapsed, and copies the same server references", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const error = makeError();
    render(<ErrorDisplay error={error} title="products" />);
    expect(screen.getByText("Couldn't load products.")).toBeVisible();
    const summary = screen.getByText("Technical details");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(
      screen.getByRole("link", { name: "View in Sentry" }),
    ).toHaveAttribute("href", sentryEventUrl("sample-event"));
    expect(
      screen.getByRole("link", { name: "Open Workers Observability" }),
    ).toHaveAttribute("href", CLOUDFLARE_OBSERVABILITY_URL);
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]?.[0]).toContain("sample-event");
  });
});

describe("error details dialog host", () => {
  it("opens with the error's content and no inline <details>, then closes", async () => {
    const error = makeError();
    render(<ErrorDetailsDialogHost />);

    act(() => {
      openErrorDetailsDialog(error);
    });

    const dialog = await screen.findByRole("dialog", {
      name: "Technical details",
    });
    expect(dialog).toHaveTextContent("entity.list / product / run");
    expect(screen.getByRole("link", { name: "View in Sentry" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy details" })).toBeVisible();
    expect(dialog.querySelector("details")).toBeNull();

    act(() => {
      closeErrorDetailsDialog();
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Technical details" }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("showErrorToast", () => {
  it("dedupes same-code errors under one toast id and opens the dialog from Details", () => {
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
    const error = makeError();

    showErrorToast(error);
    showErrorToast(error);

    expect(errorSpy).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall, ...rest] = errorSpy.mock.calls;
    expect(rest).toHaveLength(0);
    const [, firstOptions] = firstCall ?? [];
    const [, secondOptions] = secondCall ?? [];
    expect(firstOptions?.id).toBeDefined();
    expect(firstOptions?.id).toBe(secondOptions?.id);

    // SAFETY: `showErrorToast` always builds `action` as the
    // `{ label, onClick }` object literal below, never the alternate
    // `ReactNode` shape the library's `action` type otherwise allows.
    const action = firstOptions?.action as
      | { label: React.ReactNode; onClick: () => void }
      | undefined;
    expect(action?.label).toBe("Details");

    const differentError = makeError({ code: "NOT_FOUND" });
    showErrorToast(differentError);
    const [, thirdOptions] = errorSpy.mock.calls[2] ?? [];
    expect(thirdOptions?.id).not.toBe(firstOptions?.id);

    expect(getErrorDetailsDialogSnapshot().open).toBe(false);
    action?.onClick();
    expect(getErrorDetailsDialogSnapshot().open).toBe(true);
  });

  it("keys the toast id on message/code, not requestId", () => {
    const error = makeError();
    const id = errorToastId(error);
    expect(id).toContain("INTERNAL_SERVER_ERROR");
    expect(id).not.toContain("sample-ray");
  });
});
