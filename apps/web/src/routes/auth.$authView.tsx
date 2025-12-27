import { AuthView } from "@daveyplate/better-auth-ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/$authView")({
  component: AuthPage,
});

function AuthPage() {
  const { authView } = Route.useParams();
  return <AuthView pathname={authView} />;
}
