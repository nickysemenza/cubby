// Fontsource variable fonts - loaded via bundler for better performance
import "@fontsource-variable/fraunces";
import "@fontsource-variable/nunito";
import "@fontsource-variable/source-sans-3";

import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import * as React from "react";
import { GlobalCommandMenu } from "~/app/_components/command-menu";
import { MainNav } from "~/app/_components/MainNav";
import { BottomNav } from "~/app/_components/navigation/bottom-nav";
import { RouteErrorComponent } from "~/components/route-error";
import { Toaster } from "~/components/ui/sonner";
import { DebugContextProvider, useDebug } from "~/hooks/useDebug";
import type { TRPCRouter } from "~/integrations/trpc/router";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import { Provider } from "../integrations/tanstack-query/root-provider";
import appCss from "../styles.css?url";

interface MyRouterContext {
  queryClient: QueryClient;
  trpc: TRPCOptionsProxy<TRPCRouter>;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
      },
      {
        title: "Cubby",
      },
      {
        name: "theme-color",
        content: "#3a3530",
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
        href: "/favicon.svg",
      },
    ],
  }),

  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: NotFoundComponent,
  errorComponent: RouteErrorComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const [commandMenuOpen, setCommandMenuOpen] = React.useState(false);

  return (
    <Provider queryClient={queryClient}>
      <DebugContextProvider>
        <div className="flex flex-col">
          <div className="border-b">
            <div className="flex h-16 items-center px-4">
              <MainNav
                className="mx-0"
                onSearchClick={() => setCommandMenuOpen(true)}
              />
            </div>
          </div>
        </div>
        {/* Add bottom padding on mobile for bottom nav */}
        <main className="container mx-auto p-4 pb-20 md:pb-4">
          <Outlet />
        </main>
        {/* Bottom navigation for mobile */}
        <BottomNav />
        <GlobalCommandMenu
          open={commandMenuOpen}
          onOpenChange={setCommandMenuOpen}
        />
        <Toaster />
        <DevtoolsWrapper />
      </DebugContextProvider>
    </Provider>
  );
}

function DevtoolsWrapper() {
  const { isDevtoolsVisible } = useDebug();

  if (!isDevtoolsVisible) {
    return null;
  }

  return (
    <TanStackDevtools
      config={{
        position: "bottom-right",
        openHotkey: [],
      }}
      plugins={[
        {
          name: "Tanstack Router",
          render: <TanStackRouterDevtoolsPanel />,
        },
        TanStackQueryDevtools,
      ]}
    />
  );
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center space-y-6 p-4">
      <div className="flex items-center space-x-3">
        <svg viewBox="0 0 64 64" className="h-12 w-12" aria-hidden="true">
          <rect x="0" y="0" width="64" height="64" rx="10" fill="#3a3530" />
          <rect x="8" y="10" width="48" height="3" rx="1" fill="#5c5550" />
          <rect x="8" y="30" width="48" height="3" rx="1" fill="#5c5550" />
          <rect x="8" y="50" width="48" height="3" rx="1" fill="#5c5550" />
          <rect x="12" y="15" width="10" height="13" rx="2" fill="#c2603d" />
          <circle cx="32" cy="22" r="6" fill="#d98a68" />
          <rect x="42" y="17" width="10" height="11" rx="2" fill="#fdfbf7" />
          <circle cx="16" cy="42" r="5" fill="#d98a68" />
          <rect x="26" y="35" width="12" height="13" rx="2" fill="#c2603d" />
          <rect x="44" y="38" width="8" height="10" rx="2" fill="#fdfbf7" />
        </svg>
        <h1 className="font-bold text-4xl">404</h1>
      </div>
      <div className="space-y-2 text-center">
        <h2 className="font-semibold text-2xl">Page Not Found</h2>
        <p className="max-w-md text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
      </div>
      <Link
        to="/"
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm shadow transition-colors hover:bg-primary/90"
      >
        Return Home
      </Link>
    </div>
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
