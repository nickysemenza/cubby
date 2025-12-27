import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { auth } from "~/lib/auth";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/sign-in");

  return (
    <PageWrapper>
      <h1 className="mb-6 font-bold text-3xl">Dashboard</h1>
      <p className="text-lg">
        Welcome to your protected dashboard! This page is only visible to
        authenticated users.
      </p>
      <div className="mt-8 rounded-lg bg-muted p-6">
        <h2 className="mb-3 font-semibold text-xl">User</h2>
        <p className="rounded bg-accent p-2 font-mono">
          {session.user.id} — {session.user.name ?? session.user.email}
        </p>
      </div>
    </PageWrapper>
  );
}
