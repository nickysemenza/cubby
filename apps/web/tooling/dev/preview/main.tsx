import "~/fonts.css";
import "~/styles.css";

import { IconContext } from "@phosphor-icons/react/dist/lib/context";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useSearch,
} from "@tanstack/react-router";
import { StrictMode, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";

import { entities } from "~/entity/entities";
import { listOverrides } from "~/entity/list-columns/list-overrides.fixtures";
import { listPage } from "~/entity/routing/list-page";
import {
  getContext,
  Provider,
} from "~/integrations/tanstack-query/root-provider";
import { ErrorDetailsDialogHost } from "~/ui/feedback/error-details-dialog";
import { Label } from "~/ui/primitives/label";
import { NativeSelect } from "~/ui/primitives/native-select";
import { Toaster } from "~/ui/primitives/sonner";
import { ViewSwitcher } from "~/ui/primitives/view-switcher";

import {
  PREVIEW_ENTITIES,
  PREVIEW_STATES,
  previewEntitySchema,
  previewListOperation,
  previewStateSchema,
  type PreviewEntity,
  type PreviewState,
} from "./fixtures";

/**
 * Dev-only fixture preview, served by `tooling/dev/worker.ts` at
 * `/__dev/preview` and loaded straight from Vite. Nothing under `src/` imports
 * it, so production bundles never contain it or Faker.
 */
const { queryClient } = getContext();
const STATE_LABELS = {
  loading: "Loading",
  error: "Error",
  empty: "Empty",
  edge: "Edge rows",
} satisfies Record<PreviewState, string>;
const iconDefaults = { size: 24, weight: "regular" as const };

const previewSearchSchema = z.looseObject({
  entity: previewEntitySchema,
  state: previewStateSchema,
});

/**
 * The app's registered router types every navigation hook, so this standalone
 * router moves through its untyped history and parses its own search.
 */
function openPreview(entity: PreviewEntity, state: PreviewState) {
  router.history.push(
    `${previewRoute.fullPath}?${new URLSearchParams({ entity, state })}`,
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <IconContext.Provider value={iconDefaults}>
      <Provider queryClient={queryClient}>
        <Outlet />
        <Toaster />
        <ErrorDetailsDialogHost />
      </Provider>
    </IconContext.Provider>
  ),
});

const previewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__dev/preview",
  // The list writes its own search keys (sort, filters, view) beside these.
  validateSearch: previewSearchSchema,
  component: PreviewPage,
});

function PreviewToolbar({
  entity,
  state,
}: {
  entity: PreviewEntity;
  state: PreviewState;
}) {
  return (
    <header className="sticky top-0 z-40 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-3 py-2 md:px-6">
      <h1 className="text-sm font-semibold">Fixture preview</h1>
      <div className="flex items-center gap-2">
        <Label htmlFor="preview-entity" className="text-muted-foreground">
          Entity
        </Label>
        <NativeSelect
          id="preview-entity"
          value={entity}
          onChange={(event) =>
            openPreview(previewEntitySchema.parse(event.target.value), state)
          }
        >
          {PREVIEW_ENTITIES.map((option) => (
            <option key={option} value={option}>
              {entities[option].pluralLabel}
            </option>
          ))}
        </NativeSelect>
      </div>
      <ViewSwitcher
        ariaLabel="Preview state"
        options={PREVIEW_STATES.map((value) => ({
          value,
          label: STATE_LABELS[value],
        }))}
        value={state}
        onValueChange={(next) => openPreview(entity, next)}
      />
    </header>
  );
}

function PreviewPage() {
  const { entity, state } = previewSearchSchema.parse(
    useSearch({ strict: false }),
  );
  const ListPage = useMemo(
    () =>
      listPage({
        client: { entity, slots: {} },
        override: listOverrides[entity],
        operations: { list: previewListOperation(entity, state) },
      }),
    [entity, state],
  );
  return (
    <div className="flex min-h-dvh flex-col">
      <PreviewToolbar entity={entity} state={state} />
      <main className="w-full flex-1 px-2 pt-4 pb-4 md:px-6">
        <ListPage key={`${entity}:${state}`} />
      </main>
    </div>
  );
}

// The app router's query integration supplies this outer provider too; auth
// queries read it before the root route's own provider mounts.
const router = createRouter({
  routeTree: rootRoute.addChildren([previewRoute]),
  Wrap: ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  ),
});

const container = document.getElementById("root");
if (!container) throw new Error("Preview document has no #root");
// A hot update re-runs this entry; keep rendering into the same React root.
const root: Root = import.meta.hot?.data.root ?? createRoot(container);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
