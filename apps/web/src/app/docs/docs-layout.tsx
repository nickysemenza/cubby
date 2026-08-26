import { Link, Outlet } from "@tanstack/react-router";
import { groupBy } from "es-toolkit";
import { Stack } from "~/components/layout";
import { docSections } from "./docs-registry";

export const DOCS_NAV_LINK_CLASS =
  "block rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted max-md:flex max-md:min-h-11 max-md:items-center";

/**
 * Two-pane docs shell: a sidebar of sections (grouped Reference / Guides) over a
 * routed `<Outlet>`. Each link is a real `/docs/$section` route, so sections are
 * deep-linkable and shareable. On mobile the sidebar stacks above the content.
 */
export function DocsLayout() {
  const groups = groupBy(docSections, (section) => section.group);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <nav className="lg:sticky lg:top-20 lg:w-56 lg:shrink-0">
        <Stack gap="md">
          {Object.entries(groups).map(([group, sections]) => (
            <Stack key={group} gap="tight">
              <div className="eyebrow px-2">{group}</div>
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
            </Stack>
          ))}
        </Stack>
      </nav>

      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
