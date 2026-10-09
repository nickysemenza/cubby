import { AuthView } from "@daveyplate/better-auth-ui";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";

import { AuthEntryFrame } from "~/app/auth/auth-entry-frame";
import { AuthUIProvider } from "~/app/auth/auth-ui-provider";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";
import { cn } from "~/lib/utils";
import { buttonVariants } from "~/ui/primitives/button";

// Deliberately NOT loose. The OAuth server appends a signed authorize query
// here (`sig` + repeated `ba_param` names, whose signature covers the exact
// multiset), but nothing reads it through the router: the oauthProviderClient
// fetch hook pulls it straight off `window.location.search` when the sign-in
// form submits. Widening this schema would only put those params into the
// router's search union — where re-serialization could reorder or collapse the
// repeated keys and invalidate the signature — and it degrades `search` typing
// on every other route.
const searchSchema = z.object({
  redirect: urlStringParam,
  google_error: z.boolean().optional().catch(undefined),
});

const searchDefaults = {
  redirect: undefined,
  google_error: undefined,
} as const;

export const Route = createFileRoute("/auth/$authView")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  head: () => ({ meta: [{ title: pageTitle("Sign in") }] }),
  component: AuthPage,
});

function AuthPage() {
  const { authView } = Route.useParams();
  const { google_error: googleError, redirect } = Route.useSearch();

  return (
    <AuthEntryFrame>
      {googleError ? (
        <p
          role="alert"
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          Google sign-in requires read-only Gmail access. Try again and approve
          the Gmail permission.
        </p>
      ) : null}
      <AuthUIProvider>
        <AuthView pathname={authView} />
      </AuthUIProvider>
      {/* Statically false in every build, so the link never reaches a
          production bundle. The route itself exists only in tooling/dev/worker.ts. */}
      {import.meta.env.DEV && authView === "sign-in" ? (
        <a
          href={`/__dev/login?${new URLSearchParams({ next: redirect ?? "/" })}`}
          className={cn(buttonVariants({ variant: "outline" }), "mt-3 w-full")}
        >
          Continue as local dev user
        </a>
      ) : null}
    </AuthEntryFrame>
  );
}
