import type { ReactNode } from "react";
import inventoryAuditDoc from "../../../../../docs/inventory-audit.md?raw";
import { GuideDoc } from "./_components/GuideDoc";
import { ComponentDemosSection } from "./sections/component-demos-section";
import { ConceptsSection } from "./sections/concepts-section";
import { FeaturesSection } from "./sections/features-section";

/**
 * Registry of docs sections, keyed by URL slug (`/docs/<slug>`). The sidebar
 * (docs-layout) and the `/docs/$section` route both read this list, so adding a
 * section — a React page or a repo `docs/*.md` guide via {@link GuideDoc} — is a
 * single entry here. Guides keep the repo markdown as the source of truth
 * (`?raw` import); editing the `.md` updates the page.
 */
export type DocSectionGroup = "Reference" | "Guides";

export interface DocSection {
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
    render: () => <GuideDoc>{inventoryAuditDoc}</GuideDoc>,
  },
];

export const DEFAULT_DOC_SLUG = docSections[0]!.slug;

export function getDocSection(slug: string): DocSection | undefined {
  return docSections.find((section) => section.slug === slug);
}
