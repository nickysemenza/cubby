"use client";
import { AuthUIProvider as Provider } from "@daveyplate/better-auth-ui";
import { authClient } from "~/lib/auth-client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";

export function AuthUIProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <Provider
      apiKey={true}
      organization={true}
      authClient={authClient}
      navigate={router.push}
      replace={router.replace}
      onSessionChange={() => router.refresh()}
      Link={Link}
    >
      {children}
    </Provider>
  );
}
