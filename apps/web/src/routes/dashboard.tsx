import { createFileRoute } from "@tanstack/react-router";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { useAuthGuard } from "~/hooks/useAuthGuard";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  const { isLoading, isAuthenticated } = useAuthGuard();

  if (isLoading || !isAuthenticated) {
    return (
      <PageWrapper>
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-muted" />
          <div className="h-4 w-96 rounded bg-muted" />
        </div>
      </PageWrapper>
    );
  }

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
