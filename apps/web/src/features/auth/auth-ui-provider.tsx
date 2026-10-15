import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack";
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack";
import { Link as TanStackLink, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { authClient } from "~/lib/auth-client";
import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";

// Scoped to the better-auth-ui views (`/auth/$authView`,
// `/account/$accountView`) rather than the root provider, so the library
// loads with those route chunks instead of every page. Session reads elsewhere
// use `authClient.useSession()` and need no provider.

// Wrapper to adapt TanStack Router Link to better-auth-ui Link format
const Link = ({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) => (
  <TanStackLink to={href} className={className}>
    {children}
  </TanStackLink>
);

const googleSignInParams = z.object({
  provider: z.literal("google"),
  callbackURL: z.string().optional(),
});

const signInWithGoogle = (params: unknown) => {
  const parsed = googleSignInParams.parse(params);
  return authClient.signIn.social({
    provider: "google",
    callbackURL: parsed.callbackURL,
    errorCallbackURL: "/auth/sign-in?google_error=true",
    fetchOptions: { throw: true },
    requestSignUp: false,
    scopes: [GMAIL_READONLY_SCOPE],
  });
};

export function AuthUIProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  return (
    <AuthQueryProvider>
      <AuthUIProviderTanstack
        authClient={authClient}
        navigate={(href) => navigate({ to: href })}
        replace={(href) => navigate({ to: href, replace: true })}
        Link={Link}
        social={{
          providers: ["google"],
          signIn: signInWithGoogle,
        }}
        apiKey={{ prefix: "cubby_" }}
        signUp={false}
        toast={({ variant, message }) => {
          const text = message ?? "Something went wrong.";
          if (variant === "error") toast.error(text);
          else if (variant === "success") toast.success(text);
          else if (variant === "warning") toast.warning(text);
          else if (variant === "info") toast.info(text);
          else toast(text);
        }}
      >
        {children}
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  );
}
