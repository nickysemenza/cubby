import type { Entity } from "@cubby/schemas/entity";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach } from "vitest";

import { entityMetadataQueryOptions } from "~/entity/metadata";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { entityMetadataLoaders } from "~/server/generated/entity-metadata-loaders.gen";

// Test fixtures exercise the real compiler output while keeping production caches scoped.
const slices = await Promise.all(
  Object.values(entityMetadataLoaders).map((load) => load()),
);

export function seedEditorTestMetadata(queryClient: QueryClient) {
  for (const slice of slices)
    queryClient.setQueryData(
      entityMetadataQueryOptions(slice.entity).queryKey,
      slice,
    );
}

export function createEditorTestQueryClient(entities?: readonly Entity[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const slice of slices)
    if (!entities || entities.includes(slice.entity))
      queryClient.setQueryData(
        entityMetadataQueryOptions(slice.entity).queryKey,
        slice,
      );
  return queryClient;
}

export function createEditorBrowserTestHarness(
  ...args: Parameters<typeof createBrowserTestHarness>
) {
  const harness = createBrowserTestHarness(...args);
  seedEditorTestMetadata(harness.queryClient);
  return harness;
}

const renderClients = new Set<QueryClient>();
afterEach(() => {
  for (const client of renderClients) client.clear();
  renderClients.clear();
});

/** Existing primitive tests need the same explicit scope as production forms. */
export function renderWithEditorMetadata(
  ui: Parameters<typeof render>[0],
  options?: Parameters<typeof render>[1],
) {
  const queryClient = createEditorTestQueryClient();
  renderClients.add(queryClient);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return render(ui, { wrapper, ...options });
}
