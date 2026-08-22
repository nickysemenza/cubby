import { relatedViewRegistry } from "@cubby/schemas/related-view";
import type { FC, ReactNode } from "react";
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
        className={cn(section.overflowVisible && "overflow-visible")}
      >
        <CardHeader className="pb-2">
          <CardTitle as="h2">
            <section.icon className="size-3.5 shrink-0 text-slate" />
            {section.title}
          </CardTitle>
          {section.headerAction && (
            <CardAction>{section.headerAction}</CardAction>
          )}
        </CardHeader>
        <CardContent>{section.content}</CardContent>
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
  const indexed = sections.filter(
    (section) => section.includeInIndex !== false,
  );
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
  };

  return (
    <>
      <div className="sticky top-[var(--app-chrome-top)] z-30 hidden min-h-9 items-center gap-1 overflow-x-auto border-foreground border-b-[3px] bg-card px-2 md:flex">
        <span className="shrink-0 pr-2 font-mono text-2xs text-slate uppercase tracking-wider">
          Record index
        </span>
        {indexed.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            onClick={(event) => {
              event.preventDefault();
              window.history.replaceState(null, "", `#${section.id}`);
              jump(section.id);
            }}
            className="shrink-0 px-2 py-1 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {section.title}
          </a>
        ))}
      </div>
      <label className="flex min-h-11 items-center gap-2 border-border border-b bg-card px-2 md:hidden">
        <span className="shrink-0 font-mono text-2xs text-slate uppercase tracking-wider">
          Jump to
        </span>
        <select
          aria-label="Jump to section"
          defaultValue=""
          className="h-10 min-w-0 flex-1 border-0 bg-transparent px-2 text-sm"
          onChange={(event) => {
            if (event.target.value) jump(event.target.value);
            event.target.value = "";
          }}
        >
          <option value="" disabled>
            Choose section…
          </option>
          {indexed.map((section) => (
            <option key={section.id} value={section.id}>
              {section.title}
            </option>
          ))}
        </select>
      </label>
    </>
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
      <div className="space-y-2">
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
