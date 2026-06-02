import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { ProjectsDashboard } from "~/app/projects/projects-dashboard";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/_authenticated/projects/")({
  component: ProjectsPage,
  head: () => ({ meta: [{ title: "Projects | cubby" }] }),
});

function ProjectsPage() {
  return (
    <PageWrapper>
      <div className="fade-in animate-in duration-300">
        <Suspense fallback={<ProjectsSkeleton />}>
          <ProjectsDashboard />
        </Suspense>
      </div>
    </PageWrapper>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      <div className="grid gap-4 sm:grid-cols-3">
        {["s1", "s2", "s3"].map((k) => (
          <div key={k} className="h-24 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
