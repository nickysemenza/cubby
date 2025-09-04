import "~/styles/globals.css";

import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { cn } from "~/lib/utils";

import { TRPCReactProvider } from "~/trpc/react";
import { MainNav } from "./_components/MainNav";
import { GlobalCommandMenu } from "./_components/command-menu";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "~/components/ui/sonner";
import { WasmContextProvider } from "~/hooks/useWasm";

export const metadata: Metadata = {
  title: "RecipeHub",
  icons: [
    { rel: "icon", url: "/favicon-96x96.png", sizes: "96x96" },
    { rel: "shortcut icon", url: "/favicon.ico", sizes: "16x16" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en" className={cn(GeistSans.variable)}>
        <body>
          <div className="flex flex-col">
            <div className="border-b">
              <div className="flex h-16 items-center px-4">
                <MainNav className="mx-0" />
              </div>
            </div>
          </div>

          <GlobalCommandMenu />
          <Toaster />
          <TRPCReactProvider>
            <ReactQueryDevtools initialIsOpen={false} />
            <WasmContextProvider>{children}</WasmContextProvider>
          </TRPCReactProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
