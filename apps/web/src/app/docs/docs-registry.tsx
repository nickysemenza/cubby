import { lazy, type ReactNode } from "react";

// Lazy-load every section. Two independent reasons, both load-bearing:
//
// 1. The React sections pull in `_data/samples`, which generates UUIDs
//    (`crypto.randomUUID()`) at module top-level — illegal in the Cloudflare
//    Workers GLOBAL scope. The route files import this registry into the eager
//    route-tree graph, so a static import would run that UUID at worker init
//    and crash SSR. `lazy()` defers it to render time (inside a request
//    handler / on the client), where random values are allowed.
// 2. `/docs` resolves `DEFAULT_DOC_SLUG` in `beforeLoad`, so this registry is
//    in the eager chunk of every page load. Anything it imports statically
//    ships to users who never open the docs — which is how react-markdown
//    (~150 KiB, via the guide) ended up on the critical path.
//
// So: keep this file's imports to `react` alone. New sections go in
// `./sections/*`, referenced only through `lazy()`.
const ConceptsSection = lazy(() =>
  import("./sections/concepts-section").then((m) => ({
    default: m.ConceptsSection,
  })),
);
const FeaturesSection = lazy(() =>
  import("./sections/features-section").then((m) => ({
    default: m.FeaturesSection,
  })),
);
const ComponentDemosSection = lazy(() =>
  import("./sections/component-demos-section").then((m) => ({
    default: m.ComponentDemosSection,
  })),
);
const InventoryAuditGuide = lazy(() =>
  import("./sections/inventory-audit-guide").then((m) => ({
    default: m.InventoryAuditGuide,
  })),
);

/**
 * Registry of docs sections, keyed by URL slug (`/docs/<slug>`). The sidebar
 * (docs-layout) and the `/docs/$section` route both read this list, so adding a
 * section — a React page, or a repo `docs/*.md` guide wrapped in `GuideDoc` — is
 * a `./sections/*` module plus a single `lazy()` entry here. Guides keep the
 * repo markdown as the source of truth (`?raw` import); editing the `.md`
 * updates the page.
 */
type DocSectionGroup = "Reference" | "Guides";

interface DocSection {
  slug: string;
  title: string;
  group: DocSectionGroup;
  render: () => ReactNode;
}

export const docSections: DocSection[] = [
  {
    slug: "concepts",
    title: "Concepts",
    group: "Reference",
    render: () => <ConceptsSection />,
  },
  {
    slug: "features",
    title: "Features",
    group: "Reference",
    render: () => <FeaturesSection />,
  },
  {
    slug: "components",
    title: "Component demos",
    group: "Reference",
    render: () => <ComponentDemosSection />,
  },
  {
    slug: "inventory-audit",
    title: "Inventory audit",
    group: "Guides",
    render: () => <InventoryAuditGuide />,
  },
];

export const DEFAULT_DOC_SLUG = docSections[0]!.slug;

export function getDocSection(slug: string): DocSection | undefined {
  return docSections.find((section) => section.slug === slug);
}
