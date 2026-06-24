import { createFileRoute } from "@tanstack/react-router";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <Page variant="list" title="Dashboard">
      <p className="text-lg">
        Welcome to your protected dashboard! This page is only visible to
        authenticated users.
      </p>
    </Page>
  );
}
