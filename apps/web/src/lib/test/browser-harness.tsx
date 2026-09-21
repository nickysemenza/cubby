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
import {
  createContext as createReactContext,
  useContext,
  type ReactNode,
} from "react";
import { vi } from "vitest";
import type { z } from "zod";

class BrowserTestResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}

  observe(_target: Element, _options?: ResizeObserverOptions) {}

  unobserve(_target: Element) {}

  disconnect() {}
}

class BrowserTestMediaQueryList implements MediaQueryList {
  readonly matches = false;
  readonly media: string;
  onchange:
    | ((this: MediaQueryList, event: MediaQueryListEvent) => void)
    | null = null;

  constructor(media: string) {
    this.media = media;
  }

  addListener(
    _listener: (this: MediaQueryList, event: MediaQueryListEvent) => void,
  ) {}

  removeListener(
    _listener: (this: MediaQueryList, event: MediaQueryListEvent) => void,
  ) {}

  addEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ) {}

  removeEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions,
  ) {}

  dispatchEvent(_event: Event): boolean {
    return false;
  }
}

const BROWSER_TEST_VIEWPORT = { width: 1280, height: 800 } as const;
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

function installBrowserLayoutMetrics() {
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  );
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  // jsdom has no layout engine, so a virtualizer sees a zero-height pane and
  // never mounts its rows. The harness supplies a stable viewport just as a
  // browser would; individual behavior tests can still own exact measurements.
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get: () => BROWSER_TEST_VIEWPORT.width,
    },
    offsetHeight: {
      configurable: true,
      get: () => BROWSER_TEST_VIEWPORT.height,
    },
  });

  return () => {
    if (originalOffsetWidth)
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetWidth",
        originalOffsetWidth,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    if (originalOffsetHeight)
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetHeight",
        originalOffsetHeight,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  };
}

function installBrowserScrollIntoView() {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  // jsdom omits this browser method, but section navigation deliberately uses
  // it before focusing the target. A no-op keeps the browser interaction
  // contract testable without inventing a scroll-position model.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });

  return () => {
    if (originalScrollIntoView)
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  };
}

function installBrowserMatchMedia() {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (media) => new BrowserTestMediaQueryList(media);

  return () => {
    window.matchMedia = originalMatchMedia;
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
  // jsdom deliberately omits layout observers. The real virtualized table is a
  // local module we exercise in browser tests, so install its no-op browser API
  // only for this harness and remove it during deterministic cleanup.
  const needsResizeObserver = globalThis.ResizeObserver === undefined;
  if (needsResizeObserver)
    globalThis.ResizeObserver = BrowserTestResizeObserver;
  const restoreLayoutMetrics = installBrowserLayoutMetrics();
  const restoreScrollIntoView = installBrowserScrollIntoView();
  const restoreMatchMedia = installBrowserMatchMedia();
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
      queryClient.clear();
      router.history.destroy();
      restoreLayoutMetrics();
      restoreScrollIntoView();
      restoreMatchMedia();
      if (needsResizeObserver)
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      if (options?.clock) vi.useRealTimers();
    },
  };
}
