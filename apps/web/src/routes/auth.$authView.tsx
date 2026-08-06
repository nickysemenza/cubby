import { AuthView } from "@daveyplate/better-auth-ui";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { IconPattern } from "~/components/common/icon-pattern";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

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
});

const searchDefaults = { redirect: undefined } as const;

export const Route = createFileRoute("/auth/$authView")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  head: () => ({ meta: [{ title: pageTitle("Sign in") }] }),
  component: AuthPage,
});

function AuthPage() {
  const { authView } = Route.useParams();

  return (
    <div className="auth-background relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      <IconPattern />
      <div className="relative z-10 w-full max-w-md">
        <AuthView pathname={authView} />
      </div>
    </div>
  );
}
