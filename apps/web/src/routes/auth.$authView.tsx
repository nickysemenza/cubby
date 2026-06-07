import { AuthView } from "@daveyplate/better-auth-ui";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { IconPattern } from "~/components/common/icon-pattern";

const searchSchema = z.object({
  redirect: z.string().optional().catch(undefined),
});

const searchDefaults = { redirect: undefined } as const;

export const Route = createFileRoute("/auth/$authView")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: AuthPage,
});

function AuthPage() {
  const { authView } = Route.useParams();

  return (
    <div className="auth-background relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      {/* Decorative tiled icon background */}
      <IconPattern />
      {/* Auth form */}
      <div className="relative z-10 w-full max-w-md">
        <AuthView pathname={authView} />
      </div>
    </div>
  );
}
