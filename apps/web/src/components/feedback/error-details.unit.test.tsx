import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import {
  CLOUDFLARE_OBSERVABILITY_URL,
  sentryEventUrl,
} from "~/lib/error-diagnostics";

import { ErrorDisplay } from "./error-display";

describe("error details", () => {
  it("shows the cause, keeps details collapsed, and copies the same server references", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const error = new StartOperationError({
      code: "INTERNAL_SERVER_ERROR",
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
