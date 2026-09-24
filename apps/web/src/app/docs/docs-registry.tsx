import { lazy, type ReactNode } from "react";

import { docSlug } from "./doc-paths";

// This registry is imported by the eager route tree. Keep react-markdown
// behind lazy imports and emit Markdown as static assets so guide text does
// not enter executable client chunks or the Worker's global scope.
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

export interface DocSection {
  slug: string;
  title: string;
  group: string;
  sourcePath?: string;
  render: () => ReactNode;
}

const referenceSections: DocSection[] = [
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
];

const DOCS_PREFIX = "../../../../../docs/";
const markdownModules = import.meta.glob<string>(
  "../../../../../docs/**/*.md",
  { query: "?url", import: "default" },
);

const markdownSections: DocSection[] = Object.entries(markdownModules)
  .sort(([left], [right]) => {
    const leftPath = left.slice(DOCS_PREFIX.length);
    const rightPath = right.slice(DOCS_PREFIX.length);
    if (leftPath === "README.md") return -1;
    if (rightPath === "README.md") return 1;
    const leftNested = leftPath.includes("/");
    const rightNested = rightPath.includes("/");
    return (
      Number(leftNested) - Number(rightNested) || left.localeCompare(right)
    );
  })
  .map(([modulePath, load]) => {
    const sourcePath = modulePath.slice(DOCS_PREFIX.length);
    const parts = sourcePath.split("/");
    const GuideSection = lazy(async () => {
      const [sourceUrl, { GuideDoc }] = await Promise.all([
        load(),
        import("./_components/GuideDoc"),
      ]);
      return {
        default: () => (
          <GuideDoc sourcePath={sourcePath} sourceUrl={sourceUrl} />
        ),
      };
    });

    return {
      slug: docSlug(sourcePath),
      title: parts.at(-1)!,
      group: parts.length > 1 ? parts[0]! : "docs",
      sourcePath,
      render: () => <GuideSection />,
    };
  });

/** The sidebar and route use the same source-backed list. */
export const docSections: DocSection[] = [
  ...markdownSections,
  ...referenceSections,
];

export const DEFAULT_DOC_SLUG = docSlug("README.md");

export function getDocSection(slug: string): DocSection | undefined {
  return docSections.find((section) => section.slug === slug);
}
