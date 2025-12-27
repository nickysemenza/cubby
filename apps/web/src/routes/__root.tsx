// Fontsource variable fonts - loaded via bundler for better performance
import "@fontsource-variable/nunito-sans";
import "@fontsource-variable/plus-jakarta-sans";

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
import { PackageOpen } from "lucide-react";
import { GlobalCommandMenu } from "~/app/_components/command-menu";
import { MainNav } from "~/app/_components/MainNav";
import { ThemeProvider } from "~/components/theme-provider";
import { Toaster } from "~/components/ui/sonner";
import { DebugContextProvider } from "~/hooks/useDebug";
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
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "RecipeHub",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "icon",
        href: "/favicon-96x96.png",
        sizes: "96x96",
      },
      {
        rel: "shortcut icon",
        href: "/favicon.ico",
        sizes: "16x16",
      },
    ],
  }),

  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <Provider queryClient={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <DebugContextProvider>
          <div className="flex flex-col">
            <div className="border-b">
              <div className="flex h-16 items-center px-4">
                <MainNav className="mx-0" />
              </div>
            </div>
          </div>
          <main className="container mx-auto p-4">
            <Outlet />
          </main>
          <GlobalCommandMenu />
          <Toaster />
        </DebugContextProvider>
      </ThemeProvider>
    </Provider>
  );
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center space-y-6 p-4">
      <div className="flex items-center space-x-3">
        <PackageOpen className="h-12 w-12" />
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
