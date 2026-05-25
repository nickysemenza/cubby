import { createFileRoute } from "@tanstack/react-router";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { PageHero } from "~/components/layouts/page-hero";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <PageWrapper>
      <div className="fade-in animate-in duration-300">
        <PageHero variant="list" title="Dashboard" />
        <p className="text-lg">
          Welcome to your protected dashboard! This page is only visible to
          authenticated users.
        </p>
      </div>
    </PageWrapper>
  );
}
