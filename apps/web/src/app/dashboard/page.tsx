import { auth } from "~/lib/auth";
import { redirect } from "next/navigation";
import { PageWrapper } from "~/components/ui/page-wrapper";
import { headers } from "next/headers";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/sign-in");

  return (
    <PageWrapper>
      <h1 className="mb-6 text-3xl font-bold">Dashboard</h1>
      <p className="text-lg">
        Welcome to your protected dashboard! This page is only visible to
        authenticated users.
      </p>
      <div className="bg-muted mt-8 rounded-lg p-6">
        <h2 className="mb-3 text-xl font-semibold">User</h2>
        <p className="bg-accent rounded p-2 font-mono">
          {session.user.id} — {session.user.name ?? session.user.email}
        </p>
      </div>
    </PageWrapper>
  );
}
