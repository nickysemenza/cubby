import "~/styles/globals.css";
import "@daveyplate/better-auth-ui/css";

import type { Metadata } from "next";
import { TRPCReactProvider } from "~/trpc/react";
import { MainNav } from "./_components/MainNav";
import { GlobalCommandMenu } from "./_components/command-menu";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "~/components/ui/sonner";
import { WasmContextProvider } from "~/hooks/useWasm";
import { DebugContextProvider } from "~/hooks/useDebug";
import { ThemeProvider } from "~/components/theme-provider";
import { AuthUIProvider } from "./_components/AuthUIProvider";
import { Nunito_Sans } from "next/font/google";

const nunitoSans = Nunito_Sans({ subsets: ["latin"], variable: "--font-sans" });

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
    <html lang="en" suppressHydrationWarning className={nunitoSans.variable}>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AuthUIProvider>
            <DebugContextProvider>
              <TRPCReactProvider>
                <div className="flex flex-col">
                  <div className="border-b">
                    <div className="flex h-16 items-center px-4">
                      <MainNav className="mx-0" />
                    </div>
                  </div>
                </div>

                <GlobalCommandMenu />
                <Toaster />
                <ReactQueryDevtools initialIsOpen={false} />
                <WasmContextProvider>{children}</WasmContextProvider>
              </TRPCReactProvider>
            </DebugContextProvider>
          </AuthUIProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
