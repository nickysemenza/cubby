import { useQuery } from "@tanstack/react-query";
import { Github } from "lucide-react";
import { Row } from "~/components/layout";
import { authClient } from "~/lib/auth-client";
import { formatBuildDate } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";

const buildDate = formatBuildDate(__BUILD_DATE__);

function EntityCounts() {
  const api = useTRPC();
  const session = authClient.useSession();
  const isAuthenticated = !!session.data?.user;

  // The footer renders on every page; reuse the homepage's single
  // dashboard.counts query (shared key → one cheap fetch, deduped) rather than
  // four `list({pageSize:1})` calls whose product.list fired discarded USDA
  // enrichment app-wide.
  const { data: counts, isLoading } = useQuery({
    ...api.dashboard.counts.queryOptions(),
    enabled: isAuthenticated,
  });

  if (!isAuthenticated || isLoading || !counts) return null;

  const parts = [
    `${counts.product} products`,
    `${counts.location} locations`,
    `${counts.recipe} recipes`,
    `${counts.ingredient} ingredients`,
  ];

  return <span>{parts.join(" · ")}</span>;
}

export function AppFooter() {
  return (
    <footer className="safe-bottom border-t print:hidden">
      <Row
        align="center"
        justify="between"
        gap="sm"
        className="mx-auto w-full max-w-7xl px-4 py-2 font-mono text-2xs text-muted-foreground uppercase tracking-[0.12em] md:px-6"
      >
        <Row align="center" gap="sm">
          <span>
            {buildDate} · <span>{__GIT_BRANCH__}</span>@
            <span title={__GIT_COMMIT_MSG__}>{__GIT_COMMIT__}</span>
          </span>
          <span className="hidden sm:inline">
            <EntityCounts />
          </span>
        </Row>
        <Row align="center" gap="sm">
          <span className="hidden text-muted-foreground/60 sm:inline">
            ⌘K to search
          </span>
          <span
            aria-hidden="true"
            className="hidden text-muted-foreground/40 sm:inline"
          >
            ·
          </span>
          <a
            href="https://github.com/nickysemenza/recipehub"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="GitHub repository"
          >
            <Github className="h-3.5 w-3.5" />
          </a>
        </Row>
      </Row>
    </footer>
  );
}
