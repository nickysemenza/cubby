import { GitGraph } from "lucide-react";
import { Row } from "~/components/layout";
import { formatBuildDate } from "~/lib/utils";

const buildDate = formatBuildDate(__BUILD_DATE__);

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
        </Row>
        <Row align="center" gap="sm">
          <span className="hidden text-muted-foreground sm:inline">
            ⌘K to search
          </span>
          <span
            aria-hidden="true"
            className="hidden text-muted-foreground/40 sm:inline"
          >
            ·
          </span>
          <a
            href="https://github.com/nickysemenza/cubby"
            target="_blank"
            rel="noopener noreferrer"
            className="-m-2 inline-flex min-h-11 min-w-11 items-center justify-center p-2 text-muted-foreground transition-colors hover:text-foreground sm:m-0 sm:min-h-0 sm:min-w-0 sm:p-0"
            aria-label="GitHub repository"
          >
            <GitGraph className="size-3.5" />
          </a>
        </Row>
      </Row>
    </footer>
  );
}
