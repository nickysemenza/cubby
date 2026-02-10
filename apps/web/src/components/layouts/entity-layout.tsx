import { type ReactNode, Suspense } from "react";
import { SignInPrompt } from "~/components/auth/sign-in-prompt";
import { ListLoadingSkeleton } from "~/components/feedback/loading-skeletons";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { authClient } from "~/lib/auth-client";
import { HydrateClient } from "~/trpc/hydrate-client";

interface EntityLayoutProps {
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
  requireAuth?: boolean;
  fullWidth?: boolean;
}

export function EntityLayout({
  children,
  title,
  actions,
  requireAuth = true,
  fullWidth,
}: EntityLayoutProps) {
  const { data: session, isPending } = authClient.useSession();

  if (requireAuth && !isPending && !session?.user) {
    return (
      <HydrateClient>
        <PageWrapper>
          <SignInPrompt feature={title ?? "this feature"} />
        </PageWrapper>
      </HydrateClient>
    );
  }

  return (
    <HydrateClient>
      <PageWrapper fullWidth={fullWidth}>
        {(title || actions) && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
            {title && <h1 className="font-bold text-2xl">{title}</h1>}
            {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
          </div>
        )}
        <Suspense fallback={<ListLoadingSkeleton />}>{children}</Suspense>
      </PageWrapper>
    </HydrateClient>
  );
}

// Specific variants for different page types (removed unused export)
