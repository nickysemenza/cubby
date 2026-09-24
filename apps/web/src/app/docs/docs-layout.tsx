import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { groupBy } from "es-toolkit";
import { useEffect, useState } from "react";

import { Stack } from "~/components/layout";

import { docSections } from "./docs-registry";

const DOCS_NAV_LINK_CLASS =
  "block rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted max-md:flex max-md:min-h-11 max-md:items-center";

function DocsNavGroup({
  group,
  sections,
  activeSlug,
}: {
  group: string;
  sections: typeof docSections;
  activeSlug?: string;
}) {
  const active = sections.some((section) => section.slug === activeSlug);
  const [open, setOpen] = useState(group === "Reference" || active);

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group"
    >
      <summary className="flex min-h-11 cursor-pointer items-center px-2 eyebrow lg:min-h-8">
        {group}
      </summary>
      <div className="mt-1">
        {sections.map((section) => (
          <Link
            key={section.slug}
            to="/docs/$section"
            params={{ section: section.slug }}
            className={DOCS_NAV_LINK_CLASS}
            activeProps={{ className: "bg-muted font-medium" }}
          >
            {section.title}
          </Link>
        ))}
      </div>
    </details>
  );
}

function DocsNavigation({ activeSlug }: { activeSlug?: string }) {
  const groups = groupBy(docSections, (section) => section.group);
  return (
    <Stack gap="md">
      {Object.entries(groups).map(([group, sections]) => (
        <DocsNavGroup
          key={group}
          group={group}
          sections={sections}
          activeSlug={activeSlug}
        />
      ))}
    </Stack>
  );
}

/**
 * Two-pane docs shell. Folders from the repo's docs tree can be expanded
 * independently, and the current folder opens on direct navigation.
 */
export function DocsLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const currentSlug = pathname.split("/").at(-1);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <details className="rounded-md border border-border bg-card lg:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">
          Browse documentation
        </summary>
        <nav
          aria-label="Documentation"
          className="max-h-[60vh] overflow-y-auto border-t border-border px-2 py-2"
        >
          <DocsNavigation activeSlug={currentSlug} />
        </nav>
      </details>
      <nav
        aria-label="Documentation"
        className="hidden lg:sticky lg:top-20 lg:block lg:max-h-[calc(100vh-6rem)] lg:w-56 lg:shrink-0 lg:overflow-y-auto"
      >
        <DocsNavigation activeSlug={currentSlug} />
      </nav>

      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
