import { relatedViewRegistry } from "@cubby/schemas/related-view";
import { type FC, type ReactNode, useEffect, useMemo, useState } from "react";
import { usePageDetailContext } from "~/components/page/Page";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useDebug } from "~/hooks/useDebug";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";
import { EntityHero } from "../EntityHero";
import JsonRenderer from "../json-renderer";
import { RelationshipExplorer } from "../relationships/relationship-explorer";
import { relationshipsSectionIcon } from "../relationships/relationship-tree";

type DetailPlacement = "primary" | "supporting" | "full";

export interface DetailSection {
  /** Stable DOM id and section-index target. */
  id: string;
  title: string;
  content: React.ReactNode;
  icon: React.ElementType;
  /** Explicit narrative role; there is deliberately no automatic default. */
  placement: DetailPlacement;
  /** Exclude low-value/debug regions from the jump index. */
  includeInIndex?: boolean;
  /** Right-aligned header slot: a toolbar, action cluster, or rolled-up stat. */
  headerAction?: ReactNode;
  /** Let inline popovers/comboboxes escape the ruled section card. */
  overflowVisible?: boolean;
}

function SectionCard({ section }: { section: DetailSection }) {
  return (
    <section
      id={section.id}
      tabIndex={-1}
      className="scroll-mt-[calc(var(--app-chrome-top)+3rem)] focus:outline-none"
    >
      <Card
        size={section.placement === "supporting" ? "sm" : "default"}
        className={cn(
          "max-md:border-0 max-md:bg-transparent max-md:py-2",
          section.overflowVisible && "overflow-visible",
        )}
      >
        <CardHeader className="px-2 pb-1 md:px-4 md:pb-2">
          <CardTitle as="h2">
            <section.icon className="size-3.5 shrink-0 text-slate" />
            {section.title}
          </CardTitle>
          {section.headerAction && (
            <CardAction>{section.headerAction}</CardAction>
          )}
        </CardHeader>
        <CardContent className="px-2 md:px-4">{section.content}</CardContent>
      </Card>
    </section>
  );
}

const STACK_CLASS = "min-w-0 space-y-2 sm:space-y-4";

function heroVisual({
  heroImages,
  heroMedia,
}: {
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  heroMedia?: ReactNode;
}): ReactNode | undefined {
  if (heroMedia !== undefined) return <div>{heroMedia}</div>;
  return heroImages && heroImages.length > 0 ? (
    <div>
      <EntityHero images={heroImages} />
    </div>
  ) : undefined;
}

export function DetailAnchorIndex({
  sections,
}: {
  sections: Array<Pick<DetailSection, "id" | "title" | "includeInIndex">>;
}) {
  const indexed = useMemo(
    () => sections.filter((section) => section.includeInIndex !== false),
    [sections],
  );
  const indexedIds = useMemo(
    () => indexed.map((section) => section.id),
    [indexed],
  );
  const [activeId, setActiveId] = useState(indexedIds[0]);

  useEffect(() => {
    if (indexedIds.length < 2 || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) =>
              Math.abs(a.boundingClientRect.top) -
              Math.abs(b.boundingClientRect.top),
          )[0];
        if (visible?.target.id) setActiveId(visible.target.id);
      },
      { rootMargin: "-96px 0px -65% 0px", threshold: [0, 0.01, 0.5] },
    );
    for (const id of indexedIds) {
      const target = document.getElementById(id);
      if (target) observer.observe(target);
    }
    return () => observer.disconnect();
  }, [indexedIds]);

  if (indexed.length < 2) return null;

  const jump = (id: string) => {
    const target = document.getElementById(id);
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    target?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    target?.focus({ preventScroll: true });
    setActiveId(id);
  };

  return (
    <nav
      aria-label="Record sections"
      className="sticky top-[var(--app-chrome-top)] z-30 flex min-h-11 items-stretch overflow-x-auto overscroll-x-contain border-foreground border-b-[3px] bg-card px-1 [scrollbar-width:none] md:min-h-9 md:items-center md:gap-1 md:px-2 [&::-webkit-scrollbar]:hidden"
    >
      <span className="hidden shrink-0 pr-2 font-mono text-2xs text-slate uppercase tracking-wider md:block">
        Record index
      </span>
      {indexed.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={activeId === section.id ? "location" : undefined}
          onClick={(event) => {
            event.preventDefault();
            window.history.replaceState(null, "", `#${section.id}`);
            jump(section.id);
          }}
          className={cn(
            "relative flex min-h-11 shrink-0 items-center px-2 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:min-h-0 md:py-1",
            activeId === section.id
              ? "text-primary after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {section.title}
        </a>
      ))}
    </nav>
  );
}

function renderDesktopLayout({
  sections,
  visual,
}: {
  sections: DetailSection[];
  visual?: ReactNode;
}) {
  const blocks: ReactNode[] = [];
  let visualPlaced = !visual;
  let run: DetailSection[] = [];

  const flushRun = () => {
    if (run.length === 0 && visualPlaced) return;
    const current = run;
    run = [];
    const primary = current.filter(
      (section) => section.placement === "primary",
    );
    const supporting = current.filter(
      (section) => section.placement === "supporting",
    );
    const supportingNodes: ReactNode[] = supporting.map((section) => (
      <SectionCard key={section.id} section={section} />
    ));
    if (!visualPlaced && visual) {
      supportingNodes.unshift(<div key="detail-visual">{visual}</div>);
      visualPlaced = true;
    }

    if (primary.length > 0 && supportingNodes.length > 0) {
      blocks.push(
        <div
          key={`run-${blocks.length}`}
          className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]"
        >
          <div className={STACK_CLASS}>
            {primary.map((section) => (
              <SectionCard key={section.id} section={section} />
            ))}
          </div>
          <div className={STACK_CLASS}>{supportingNodes}</div>
        </div>,
      );
      return;
    }

    if (primary.length > 0) {
      blocks.push(
        <div key={`run-${blocks.length}`} className={STACK_CLASS}>
          {primary.map((section) => (
            <SectionCard key={section.id} section={section} />
          ))}
        </div>,
      );
      return;
    }

    if (supportingNodes.length > 0) {
      blocks.push(
        <div
          key={`run-${blocks.length}`}
          className="grid items-start gap-4 md:grid-cols-2 lg:grid-cols-3"
        >
          {supportingNodes}
        </div>,
      );
    }
  };

  for (const section of sections) {
    if (section.placement === "full") {
      flushRun();
      blocks.push(<SectionCard key={section.id} section={section} />);
    } else {
      run.push(section);
    }
  }
  flushRun();
  return <div className="space-y-4">{blocks}</div>;
}

function renderSectionLayout({
  sections,
  isMobile,
  heroImages,
  heroMedia,
}: {
  sections: DetailSection[];
  isMobile: boolean;
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  heroMedia?: ReactNode;
}) {
  if (isMobile) {
    return (
      <div className="divide-y divide-border border-border border-y">
        {sections.map((section) => (
          <SectionCard key={section.id} section={section} />
        ))}
      </div>
    );
  }
  return renderDesktopLayout({
    sections,
    visual: heroVisual({ heroImages, heroMedia }),
  });
}

interface DetailSectionsProps {
  sections: DetailSection[];
  rawData: unknown;
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  heroMedia?: ReactNode;
}

export const DetailSections: FC<DetailSectionsProps> = ({
  sections,
  rawData,
  heroImages,
  heroMedia,
}) => {
  const { isDebugEnabled } = useDebug();
  const isMobile = useIsMobile();
  const pageDetail = usePageDetailContext();
  const sourceId =
    pageDetail?.rawData &&
    typeof pageDetail.rawData === "object" &&
    "id" in pageDetail.rawData &&
    typeof pageDetail.rawData.id === "string"
      ? pageDetail.rawData.id
      : undefined;
  const hasSourceViews = relatedViewRegistry.some(
    (view) => view.source === pageDetail?.entity,
  );
  const relationshipSection: DetailSection | undefined =
    pageDetail && sourceId && hasSourceViews
      ? {
          id: "relationships",
          title: "Relationships",
          icon: relationshipsSectionIcon,
          placement: "full",
          content: (
            <RelationshipExplorer
              entity={pageDetail.entity}
              sourceId={sourceId}
            />
          ),
        }
      : undefined;
  const allSections = (
    relationshipSection ? [...sections, relationshipSection] : sections
  ).filter(
    (section) => section.content !== null && section.content !== undefined,
  );
  const ids = allSections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Detail section ids must be unique within a record page");
  }

  return (
    <div className="space-y-2 sm:space-y-4">
      <DetailAnchorIndex sections={allSections} />
      <div className="fade-in-0 slide-in-from-bottom-1 animate-in duration-150 motion-reduce:animate-none">
        {renderSectionLayout({
          sections: allSections,
          isMobile,
          heroImages,
          heroMedia: heroMedia ?? pageDetail?.heroMedia,
        })}
      </div>

      {isDebugEnabled && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle as="h2">Raw Details</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonRenderer input={rawData} pretty />
          </CardContent>
        </Card>
      )}
    </div>
  );
};
