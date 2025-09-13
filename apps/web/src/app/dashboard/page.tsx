import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { PageWrapper } from "~/components/ui/page-wrapper";

export default async function DashboardPage() {
  const { userId } = await auth();
  // If the user is not authenticated, redirect to sign-in
  if (!userId) {
    redirect("/sign-in");
  }

  return (
    <PageWrapper>
      <h1 className="mb-6 text-3xl font-bold">Dashboard</h1>
      <p className="text-lg">
        Welcome to your protected dashboard! This page is only visible to
        authenticated users.
      </p>
      <div className="bg-muted mt-8 rounded-lg p-6">
        <h2 className="mb-3 text-xl font-semibold">User ID</h2>
        <p className="bg-accent rounded p-2 font-mono">{userId}</p>
      </div>
    </PageWrapper>
  );
}
