import { OrganizationView } from "@daveyplate/better-auth-ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/organization/$organizationView")({
  component: OrganizationPage,
});

function OrganizationPage() {
  const { organizationView } = Route.useParams();
  return <OrganizationView pathname={organizationView} />;
}
