import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ensureDetailRecord } from "./detail-loader";
import { detailPage } from "./detail-page";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("detailPage", () => {
  it("finishes route loading when the inspector releases its in-flight detail read", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const gate = Promise.withResolvers<{ id: string }>();
    const started = Promise.withResolvers<void>();
    const options = {
      queryKey: ["synthetic-detail"],
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        signal.throwIfAborted();
        started.resolve();
        return gate.promise;
      },
    };
    const inspector = new QueryObserver(client, options);
    const closeInspector = inspector.subscribe(() => undefined);
    await started.promise;
    const navigation = ensureDetailRecord(client, options);
    const completed = navigation.catch((error: unknown) => error);
    closeInspector();
    gate.resolve({ id: "PRD-AAAA" });
    try {
      expect(await completed).toBeUndefined();
    } finally {
      client.clear();
    }
  });
  it("transitions a refetched missing record into route not-found", async () => {
    const Detail = detailPage({
      query: () => ({
        queryKey: ["record"] as const,
        queryFn: async () => null,
      }),
      render: () => <div>record</div>,
      title: () => "Record",
    });
    const browserHarness = createBrowserTestHarness({
      initialPath: "/products/PRD-TEST",
      route: {
        path: "/products/$shortcode",
        component: Detail,
        notFoundComponent: () => <div>Record not found</div>,
      },
    });
    harness = browserHarness;
    browserHarness.queryClient.setQueryData(["record"], null);
    await act(async () => {
      await browserHarness.loadRouter();
    });

    render(<div />, { wrapper: browserHarness.routerWrapper });

    expect(screen.getByText("Record not found")).toBeVisible();
  });
});
