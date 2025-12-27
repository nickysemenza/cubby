import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { authClient } from "~/lib/auth-client";

/**
 * Hook that redirects to sign-in if user is not authenticated.
 * Use this in protected route components.
 *
 * @param redirectTo - Where to redirect after sign-in (defaults to current path)
 * @returns Session data and loading state
 *
 * @example
 * function DashboardPage() {
 *   const { session, isLoading } = useAuthGuard();
 *   if (isLoading) return <LoadingSkeleton />;
 *   // User is authenticated here
 *   return <Dashboard user={session.user} />;
 * }
 */
export const useAuthGuard = (redirectTo?: string) => {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session?.user) {
      const returnUrl = redirectTo ?? window.location.pathname;
      navigate({
        to: "/auth/$authView",
        params: { authView: "sign-in" },
        search: { redirect: returnUrl },
      });
    }
  }, [isPending, session, navigate, redirectTo]);

  return {
    session,
    isLoading: isPending,
    isAuthenticated: !!session?.user,
  };
};
