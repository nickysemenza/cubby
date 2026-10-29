import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRoute,
  createRootRoute,
  createRouter,
  Match,
  type NotFoundRouteComponent,
  Outlet,
  rootRouteId,
  type RouteComponent,
  RouterContextProvider,
} from "@tanstack/react-router";
import { cleanup } from "@testing-library/react";
import {
  createContext as createReactContext,
  useContext,
  type ReactNode,
} from "react";
import { vi } from "vitest";
import type { z } from "zod";

import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";

type BrowserTestSearch = Record<
  string,
  z.infer<ReturnType<typeof z.json>> | undefined
>;

interface BrowserTestRoute {
  readonly path: string;
  readonly component: RouteComponent;
  readonly validateSearch?: (search: BrowserTestSearch) => BrowserTestSearch;
  readonly notFoundComponent?: NotFoundRouteComponent;
}

interface BrowserTestHarnessOptions {
  readonly initialPath?: string;
  /** Exercise route-loader ownership of shared queries before observers mount. */
  readonly loader?: () => void | Promise<void>;
  readonly route?: BrowserTestRoute;
  /** Pin timer-driven UI behavior without leaking fake timers into later tests. */
  readonly clock?: { now: number | Date };
}

let prepareEnvironment: () => () => void = () => () => {};

/** Only the jsdom setup supplies emulation; Chromium keeps its native APIs. */
export function configureBrowserTestEnvironment(
  prepare: typeof prepareEnvironment,
) {
  const previous = prepareEnvironment;
  prepareEnvironment = prepare;
  return () => {
    prepareEnvironment = previous;
  };
}

/**
 * Isolated browser providers for UI hook tests.
 *
 * Each harness owns a new query cache and memory router. Call `dispose` in the
 * test's cleanup so observers and router subscriptions cannot reach the next
 * test file. Production operation descriptors already expose their transport
 * adapter; tests that do not exercise an operation should inject query options
 * at their caller's existing interface instead of inventing another seam.
 */
export function createBrowserTestHarness(options?: BrowserTestHarnessOptions) {
  if (options?.clock) vi.useFakeTimers({ now: options.clock.now });
  const restoreEnvironment = prepareEnvironment();
  // No server runs under jsdom: an operation without an injected transport
  // rejects now, inside the test, rather than seconds later after teardown.
  const restoreStartDispatch = overrideOperationDispatch((operation) =>
    Promise.reject(
      new Error(
        `${operation} reached the Start transport in a browser test; inject one with withTransport.`,
      ),
    ),
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const testContent = createReactContext<ReactNode>(null);
  function TestRouteContent() {
    const content = useContext(testContent);
    return options?.route ? <Outlet /> : content;
  }
  const rootRoute = createRootRoute({
    component: TestRouteContent,
    loader: options?.loader,
  });
  const route = options?.route
    ? createRoute({
        getParentRoute: () => rootRoute,
        path: options.route.path,
        component: options.route.component,
        validateSearch: options.route.validateSearch,
        notFoundComponent: options.route.notFoundComponent,
      })
    : null;
  const router = createRouter({
    routeTree: route ? rootRoute.addChildren([route]) : rootRoute,
    history: createMemoryHistory({
      initialEntries: [options?.initialPath ?? "/"],
    }),
    // TanStack still wires the render subscriber when this is a boolean; the
    // predicate prevents jsdom from receiving unsupported `window.scrollTo`.
    scrollRestoration: () => false,
  });
  // `RouterContextProvider` keeps test children synchronous, unlike the full
  // provider which first resolves in a layout effect. Seed the router's own
  // initial matches and render its root Match so nearest-match hooks observe
  // the same active root route a browser does from first render. The child
  // route remains part of that matched tree when an explicit route is supplied.
  router.stores.setMatches(router.matchRoutes(router.latestLocation));

  function BrowserTestProviders({ children }: { children: ReactNode }) {
    return (
      <testContent.Provider value={children}>
        <QueryClientProvider client={queryClient}>
          <RouterContextProvider router={router}>
            <Match routeId={rootRouteId} />
          </RouterContextProvider>
        </QueryClientProvider>
      </testContent.Provider>
    );
  }

  const BrowserRouterTestProviders = BrowserTestProviders;

  return {
    queryClient,
    router,
    clock: options?.clock
      ? {
          now: () => Date.now(),
          advanceBy: async (milliseconds: number) => {
            await vi.advanceTimersByTimeAsync(milliseconds);
          },
        }
      : undefined,
    loadRouter: () => router.load(),
    wrapper: BrowserTestProviders,
    routerWrapper: BrowserRouterTestProviders,
    dispose: () => {
      // Unmount before tearing anything down. Test files dispose in their own
      // afterEach, which runs before the setup file's `cleanup()`; clearing the
      // cache or removing the stubs under a still-mounted tree re-rendered it
      // against missing globals (uncaught `matchMedia`/`IntersectionObserver`
      // errors). An unmount that throws still restores every global below.
      try {
        cleanup();
      } finally {
        queryClient.clear();
        router.history.destroy();
        restoreEnvironment();
        restoreStartDispatch();
        if (options?.clock) vi.useRealTimers();
      }
    },
  };
}
