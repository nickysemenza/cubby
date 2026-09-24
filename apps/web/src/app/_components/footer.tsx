import { GraphIcon as GitGraph } from "@phosphor-icons/react/dist/csr/Graph";

import { Row } from "~/components/layout";
import type { BuildMetadata } from "~/lib/build-metadata";
import { formatBuildDate } from "~/lib/utils";

export function AppFooter({ metadata }: { metadata: BuildMetadata }) {
  const buildDate = formatBuildDate(metadata.date);
  return (
    <footer className="safe-bottom border-t print:hidden">
      <Row
        align="center"
        justify="between"
        gap="sm"
        className="mx-auto w-full max-w-7xl px-4 py-2 font-mono text-2xs text-muted-foreground md:px-6"
      >
        <Row align="center" gap="sm">
          <span data-testid="build-metadata">
            {buildDate} · <span>{metadata.branch}</span>@
            <a
              href={`https://github.com/nickysemenza/cubby/commit/${metadata.commit}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`View ${metadata.branch}@${metadata.commit} on GitHub`}
              className="inline-flex min-h-11 items-center px-1 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-0 sm:px-0"
            >
              {metadata.commit}
            </a>
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
