import "~/styles/globals.css";

import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";
import {
  ClerkProvider,
  SignInButton,
  SignedIn,
  SignedOut,
  UserButton,
} from "@clerk/nextjs";

import { TRPCReactProvider } from "~/trpc/react";
import { MainNav } from "./_components/MainNav";
import Link from "next/link";
import { PackageOpen } from "lucide-react";
import { GlobalCommandMenu } from "./_components/command-menu";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "~/components/ui/sonner";

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
      <html lang="en" className={`${GeistSans.variable}`}>
        <body>
          <div className="hidden flex-col md:flex">
            <div className="border-b">
              <div className="flex h-16 items-center px-4">
                <Link href="/" className="flex items-center space-x-3">
                  <PackageOpen />
                  <span className="self-center text-2xl font-semibold whitespace-nowrap dark:text-white">
                    recipehub
                  </span>
                </Link>
                <MainNav className="mx-6" />
                <div className="ml-auto flex items-center space-x-4">
                  <SignedOut>
                    <SignInButton />
                  </SignedOut>
                  <SignedIn>
                    <UserButton />
                  </SignedIn>
                </div>
              </div>
            </div>
          </div>

          <GlobalCommandMenu />
          <Toaster />
          <TRPCReactProvider>
            <ReactQueryDevtools initialIsOpen={false} />

            {children}
          </TRPCReactProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
