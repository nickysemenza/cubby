import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  BackgroundRefreshStatus,
  ShellStatusSlot,
} from "./background-refresh-status";

afterEach(() => vi.useRealTimers());

function heldRead() {
  let resolve = (_value: string) => {};
  const promise = new Promise<string>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it("shows only slow background refetches and resets the delay after idle", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const meta = { cacheTags: [["imageJob"] as const] };
  const view = render(
    <QueryClientProvider client={client}>
      <ShellStatusSlot>
        <BackgroundRefreshStatus />
      </ShellStatusSlot>
    </QueryClientProvider>,
  );
  // A slow first load belongs to the page's own loading UI.
  const initial = heldRead();
  const initialFetch = client.fetchQuery({
    queryKey: ["initial"],
    meta,
    queryFn: () => initial.promise,
  });
  await advance(500);
  expect(screen.queryByLabelText("Syncing")).toBeNull();
  await act(async () => {
    initial.resolve("loaded");
    await initialFetch;
  });

  const background = heldRead();
  const refetch = client.fetchQuery({
    queryKey: ["initial"],
    meta,
    queryFn: () => background.promise,
  });
  await advance(0);
  await advance(299);
  expect(screen.queryByLabelText("Syncing")).toBeNull();
  await advance(1);
  expect(screen.getByLabelText("Syncing")).toBeVisible();
  await act(async () => {
    background.resolve("updated");
    await refetch;
  });
  await advance(0);
  expect(screen.queryByLabelText("Syncing")).toBeNull();

  const fast = heldRead();
  const fastFetch = client.fetchQuery({
    queryKey: ["initial"],
    meta,
    queryFn: () => fast.promise,
  });
  await advance(100);
  expect(screen.queryByLabelText("Syncing")).toBeNull();
  await act(async () => {
    fast.resolve("updated again");
    await fastFetch;
  });
  await advance(300);
  expect(screen.queryByLabelText("Syncing")).toBeNull();
  view.unmount();
  client.clear();
});
