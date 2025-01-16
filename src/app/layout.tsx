import "~/styles/globals.css";

import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";

import { TRPCReactProvider } from "~/trpc/react";
import Navbar from "./_components/navbar";
import { ToastContainer } from "react-toastify";

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
    <html lang="en" className={`${GeistSans.variable}`}>
      <body>
        <Navbar />
        <ToastContainer />
        <TRPCReactProvider>{children}</TRPCReactProvider>
      </body>
    </html>
  );
}
