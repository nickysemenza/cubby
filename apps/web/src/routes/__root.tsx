// Fontsource variable fonts - loaded via bundler for better performance.
// Porcelain Transit type system: Inter carries headings and UI prose while
// JetBrains Mono is reserved for aligned data, measures, dates, and codes.
import "../fonts.css";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { createClientOnlyFn } from "@tanstack/react-start";
import * as React from "react";

import {
  loadCommandMenu,
  markCommandMenuOpen,
  preloadCommandMenu,
} from "~/app/_components/command-menu-loader";
import { AppFooter } from "~/app/_components/footer";
import { MainNav } from "~/app/_components/MainNav";
import { AuthenticatedAppShell } from "~/app/_components/navigation/authenticated-app-shell";
import { BottomNav } from "~/app/_components/navigation/bottom-nav";
import { ErrorDetailsDialogHost } from "~/components/feedback/error-details-dialog";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { RouteNotFound } from "~/components/lazy-route-not-found";
import { Toaster } from "~/components/ui/sonner";
import { useDebug } from "~/hooks/useDebug";
import { useNavAuthed } from "~/hooks/useNavAuthed";
import { getClientAuthed, getGuardSession } from "~/lib/auth-guard";
import { buildMetadataQueryOptions } from "~/lib/build-metadata";
import { FLAGS } from "~/lib/flags";
import { PerfProfiler } from "~/lib/perf/PerfProfiler";

import { Provider } from "../integrations/tanstack-query/root-provider";

import appCss from "../styles.css?url";

// Lazy: the command menu pulls in cmdk + react-markdown + the agent stream,
// none of which is needed for first paint. Loaded on first ⌘K / search click.
const GlobalCommandMenu = React.lazy(loadCommandMenu);

// Keep production devtools out of the initial client path. The `devtools`
// flag still controls whether this lazy chunk is requested and mounted.
const loadTanStackDevtools = createClientOnlyFn(
  () => import("~/integrations/tanstack-devtools"),
);
const TanStackDevtoolsMount = React.lazy(loadTanStackDevtools);

// Lazy + flag-gated: the perf overlay and its web-vitals collector only load
// when the `perfOverlay` flag is on (flags.ts, compile-time).
const PerfOverlay = React.lazy(() =>
  import("~/app/_components/perf-overlay").then((m) => ({
    default: m.PerfOverlay,
  })),
);

function PerfOverlayMount() {
  const enabled = FLAGS.perfOverlay;
  if (!enabled) return null;
  return (
    <React.Suspense fallback={null}>
      <PerfOverlay />
    </React.Suspense>
  );
}

interface MyRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  // Resolve `isAuthed` for nav chrome (MainNav, BottomNav) + the child guards
  // (`/`, `_authenticated`). On the SERVER (SSR / direct + refresh loads) read
  // the signed session cookie in-process so the first paint isn't a flash and
  // direct loads to protected routes gate server-side (the security path). On
  // CLIENT navigations read better-auth's in-memory session store synchronously
  // instead — `import.meta.env.SSR` is statically replaced, so the server-fn is
  // dead-code-eliminated from the client bundle and an in-app navigation no
  // longer pays a `/_serverFn/` round-trip.
  beforeLoad: async () => {
    if (import.meta.env.SSR) {
      const session = await getGuardSession();
      return { isAuthed: !!session };
    }
    return { isAuthed: getClientAuthed() };
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(buildMetadataQueryOptions),
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        // Phone layouts are authored at 1×, so prevent accidental zoom-out
        // without blocking pinch-to-enlarge accessibility. Deliberately omit
        // maximum-scale / user-scalable=no: people must still be able to zoom
        // in when they need to read or operate dense household records.
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, minimum-scale=1, viewport-fit=cover",
      },
      {
        title: "Cubby",
      },
      {
        name: "description",
        content:
          "A private household workspace for inventory, purchases, projects, recipes, and meal planning.",
      },
      {
        // Keep browser and installed-PWA chrome on the Porcelain canvas.
        name: "theme-color",
        content: "#f7f9fc",
      },
      {
        name: "apple-mobile-web-app-title",
        content: "Cubby",
      },
      {
        name: "apple-mobile-web-app-capable",
        content: "yes",
      },
      {
        name: "apple-mobile-web-app-status-bar-style",
        content: "black-translucent",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "manifest",
        href: "/manifest.json",
      },
      {
        rel: "icon",
        type: "image/svg+xml",
        // Localhost gets a hot-magenta variant so the dev tab is obvious
        // among prod tabs; build-time DEV flag → no hydration mismatch.
        href: import.meta.env.DEV ? "/favicon-dev.svg" : "/favicon.svg",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon.png",
      },
      // Apple splash screens — generated by `pnpm run gen:pwa-splash`
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-750x1334.png",
        media:
          "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-828x1792.png",
        media:
          "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-1125x2436.png",
        media:
          "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-1170x2532.png",
        media:
          "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-1179x2556.png",
        media:
          "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-1206x2622.png",
        media:
          "(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-1284x2778.png",
        media:
          "(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-1290x2796.png",
        media:
          "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-1320x2868.png",
        media:
          "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-1620x2160.png",
        media:
          "(device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-1668x2388.png",
        media:
          "(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/splash/apple-splash-2048x2732.png",
        media:
          "(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2)",
      },
    ],
  }),

  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: RouteNotFound,
  errorComponent: RouteErrorComponent,
});

function RootComponent() {
  const buildMetadata = Route.useLoaderData();
  const footer = <AppFooter metadata={buildMetadata} />;
  const { queryClient } = Route.useRouteContext();
  const mainContentId = React.useId();
  const authed = useNavAuthed();
  const isWorkspaceRoute = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) => match.routeId === "/_authenticated" || match.routeId === "/",
      ),
  });
  const [commandMenuOpen, setCommandMenuOpen] = React.useState(false);
  // Only mount (and thus fetch the chunk for) the command menu once it's first
  // requested. `mounted` latches true so it stays mounted after the first open.
  const [commandMenuMounted, setCommandMenuMounted] = React.useState(false);

  const openCommandMenu = React.useCallback(() => {
    markCommandMenuOpen();
    preloadCommandMenu();
    setCommandMenuMounted(true);
    setCommandMenuOpen(true);
  }, []);

  // Shell-owned ⌘K hotkey (toggles), so the shortcut works before the lazily
  // loaded menu has mounted. The menu no longer registers its own listener.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (!commandMenuOpen) markCommandMenuOpen();
        preloadCommandMenu();
        setCommandMenuMounted(true);
        setCommandMenuOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [commandMenuOpen]);

  const routeContent = (
    <PerfProfiler id="route">
      <Outlet />
    </PerfProfiler>
  );

  return (
    <Provider queryClient={queryClient}>
      <a
        href={`#${mainContentId}`}
        className="fixed start-2 top-0 z-[100] -translate-y-full border border-foreground bg-card px-4 py-2 text-sm font-medium text-foreground transition-transform focus:top-[calc(env(safe-area-inset-top)+0.5rem)] focus:translate-y-0"
      >
        Skip to main content
      </a>
      {authed && isWorkspaceRoute ? (
        <AuthenticatedAppShell
          footer={footer}
          mainContentId={mainContentId}
          onSearchClick={openCommandMenu}
          navigationProgress={<NavigationProgress />}
        >
          {routeContent}
        </AuthenticatedAppShell>
      ) : (
        <div className="flex min-h-dvh flex-col">
          <div className="safe-top sticky top-0 z-40 border-b bg-card print:hidden">
            <div className="mx-auto flex h-12 w-full max-w-7xl items-center px-2 md:px-6">
              <MainNav className="mx-0" onSearchClick={openCommandMenu} />
            </div>
            <NavigationProgress />
          </div>
          <main
            id={mainContentId}
            tabIndex={-1}
            className="w-full flex-1 px-2 pt-4 pb-20 md:px-6 md:pb-4"
          >
            {routeContent}
          </main>
          {footer}
        </div>
      )}
      <BottomNav />
      {commandMenuMounted && (
        <React.Suspense fallback={null}>
          <GlobalCommandMenu
            open={commandMenuOpen}
            onOpenChange={setCommandMenuOpen}
          />
        </React.Suspense>
      )}
      <Toaster />
      <ErrorDetailsDialogHost />
      <PerfOverlayMount />
      <DevtoolsWrapper />
    </Provider>
  );
}

/** A quiet progress rule only for navigations slow enough for users to notice. */
function NavigationProgress() {
  const isLoading = useRouterState({ select: (state) => state.isLoading });
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (!isLoading) {
      setVisible(false);
      return;
    }
    const timeout = window.setTimeout(() => setVisible(true), 120);
    return () => window.clearTimeout(timeout);
  }, [isLoading]);

  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
    >
      {visible && (
        <div className="h-full w-2/5 animate-pulse bg-primary motion-reduce:animate-none" />
      )}
    </div>
  );
}

function DevtoolsWrapper() {
  const { isDevtoolsVisible } = useDebug();

  if (!isDevtoolsVisible) {
    return null;
  }

  return (
    <React.Suspense fallback={null}>
      <TanStackDevtoolsMount />
    </React.Suspense>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
