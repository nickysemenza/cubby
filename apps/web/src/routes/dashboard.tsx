import { createFileRoute } from "@tanstack/react-router";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <PageWrapper>
      <div className="fade-in animate-in duration-300">
        <h1 className="mb-6 font-bold font-heading text-3xl">Dashboard</h1>
        <p className="text-lg">
          Welcome to your protected dashboard! This page is only visible to
          authenticated users.
        </p>
      </div>
    </PageWrapper>
  );
}
