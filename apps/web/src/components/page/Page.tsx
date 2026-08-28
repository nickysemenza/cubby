import type { Entity } from "@cubby/schemas/entity";
import {
  createContext,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useState,
} from "react";

import { ListLoadingSkeleton } from "~/components/feedback/loading-skeletons";
import { type PageLayout, PageWrapper } from "~/components/layout/page-wrapper";
import {
  type DetailHeroActions,
  type DetailHeroStat,
  PageHeader,
} from "~/components/layouts/page-hero";
import { useRouteEntity } from "~/hooks/useRouteEntity";

// Lets a list component (which owns the query) report its loaded record
// count up to the enclosing <Page> (which owns the header) without threading
// a prop through every route file. `null` outside a <Page> (or when nothing
// has reported yet) — consumers no-op in that case, see usePageCount.
const PageCountContext = createContext<
  ((count: number | undefined) => void) | null
>(null);

/**
 * Page identity handed DOWN to a page-level table so its toolbar can carry the
 * page's name, count and actions from a stable workbench above it.
 *
 * Provided at render time rather than registered by the table in an effect: a
 * table that claimed the header after paint would make the H1 appear and then
 * vanish on every navigation. `listChrome` is therefore the route's explicit
 * statement, and pages without an operating surface keep their hero.
 */
export interface PageIdentity {
  title: ReactNode;
  eyebrow?: ReactNode;
  entity?: Entity;
  count?: number;
  actions?: ReactNode;
}

const PageIdentityContext = createContext<PageIdentity | null>(null);

/** Portal target for table-owned Display and Saved views controls. */
export function usePageWorkbenchTarget(): HTMLDivElement | null {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setTarget(
      document.querySelector<HTMLDivElement>("[data-workbench-utilities]"),
    );
  }, []);
  return target;
}

/**
 * Read the page's identity from a page-level table's toolbar. `null` on an
 * embedded table, on a page whose route did not opt in, and outside `<Page>` —
 * every consumer must treat that as "render no identity".
 */
export function usePageIdentity(): PageIdentity | null {
  return useContext(PageIdentityContext);
}

/** Detail-only context keeps shared body sections aware of their owner. */
const PageDetailContext = createContext<
  { entity: Entity; rawData: unknown; heroMedia?: ReactNode } | undefined
>(undefined);

export function usePageDetailContext() {
  return useContext(PageDetailContext);
}

/**
 * Report a list's true filtered record count up to the enclosing `<Page>`
 * header, rendered as "1,240 EXPENSES" at the end of the eyebrow line. Pass
 * `useEntityList`'s `totalCount`.
 *
 * Effect-based and client-only by design: SSR/first paint renders with no
 * count (avoiding a hydration mismatch), and the count appears a tick after
 * mount once the query resolves. Cleans back up to `undefined` on unmount so
 * switching views (e.g. table vs. gallery) or navigating away never leaves a
 * stale count behind. A no-op outside a `<Page>` (context is `null`) — safe
 * to call from list components that are also embedded standalone elsewhere
 * (e.g. a detail page's nested list).
 */
export function usePageCount(totalCount: number | undefined) {
  const setCount = useContext(PageCountContext);
  useEffect(() => {
    setCount?.(totalCount);
    return () => setCount?.(undefined);
  }, [setCount, totalCount]);
}

interface PageBaseProps {
  title: ReactNode;
  eyebrow?: ReactNode;
  layout?: PageLayout;
  children: ReactNode;
}

/**
 * A bounded page body without a page header. Pending states and print-oriented
 * surfaces still need the same readable-width container, but must not invent
 * an identity header while the route is unavailable.
 */
interface PageBareProps {
  variant: "bare";
  children: ReactNode;
  layout?: PageLayout;
}

interface PageListProps extends PageBaseProps {
  variant?: "list";
  entity?: Entity;
  actions?: ReactNode;
  compact?: boolean;
  decoration?: "accent" | "none";
  /**
   * List pages that are durable operating surfaces use a compact ruled
   * workbench header instead of the editorial page hero. The header remains
   * mounted while the body swaps between table, shelf, board, chart, or other
   * renderers, so page identity and primary actions never jump with the view.
   */
  listChrome?: "hero" | "workbench";
  /** View/mode control rendered in the workbench's first tier. */
  workbenchControls?: ReactNode;
  /** Today keeps its compact greeting visible; other phone route titles live in the contextual bar. */
  mobileTitleVisible?: boolean;
  /**
   * Standard reading/dashboard gutters inside a full-width page. Ledger and
   * table renderers stay flush so their rules can reach the viewport edge.
   */
  bodyGutter?: "none" | "standard";
}

interface PageDetailProps extends PageBaseProps {
  variant: "detail";
  entity: Entity;
  heroStamp?: { label: string; tone?: "ink" | "red" | "green" };
  heroStats?: DetailHeroStat[];
  heroNo?: string;
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  /**
   * Detail-only sourced media. This is intentionally separate from
   * `heroImages`: callers can show related imagery without implying it is an
   * attachment owned by this record.
   */
  heroMedia?: ReactNode;
  /** One visible primary action plus secondary actions that collapse on phone. */
  heroActions?: DetailHeroActions;
  rawData?: unknown;
}

/**
 * Discriminated union — `variant="detail"` requires `entity` at compile time
 * (the spec-plate can't render without it), so callers get a TS error instead of
 * the runtime guard in {@link PageHeader}.
 */
type PageProps = PageBareProps | PageListProps | PageDetailProps;

/**
 * The single page shell for bounded bare, list, and detail surfaces. List and
 * detail pages add the unified {@link PageHeader} and a Suspense boundary;
 * `bare` preserves the same width contract without inventing route identity.
 */
export function Page(props: PageProps) {
  if (props.variant === "bare") {
    return <PageWrapper layout={props.layout}>{props.children}</PageWrapper>;
  }

  return <PageWithHeader {...props} />;
}

function PageWithHeader(props: PageListProps | PageDetailProps) {
  const { title, eyebrow, layout, children } = props;
  const variant = props.variant ?? "list";
  // List pages can omit `entity` — derive it from the route so the eyebrow/accent
  // still render. Detail pages always pass it explicitly (TS-required).
  const autoEntity = useRouteEntity();
  const entity = props.entity ?? autoEntity;
  // Detail-only spec-plate extras, narrowed off the union.
  const detail = props.variant === "detail" ? props : undefined;
  // List-only header options, narrowed off the union.
  const list = props.variant !== "detail" ? props : undefined;
  const actions = list?.actions;
  // Reported by a descendant list via usePageCount; undefined until a client
  // effect fires (or on pages with no list, or non-list variants).
  const [count, setCount] = useState<number | undefined>(undefined);
  const listChrome = list?.listChrome ?? "hero";
  const bodyGutter = list?.bodyGutter ?? "none";
  const loadingLabel =
    typeof title === "string"
      ? `Loading ${title.toLocaleLowerCase()}${variant === "detail" ? " details" : " records"}…`
      : "Loading records…";
  const identity: PageIdentity | null =
    listChrome === "workbench"
      ? { title, eyebrow, entity, count, actions }
      : null;
  return (
    <PageWrapper layout={layout}>
      <div className={variant === "detail" ? "space-y-2" : undefined}>
        <PageHeader
          variant={variant}
          title={title}
          eyebrow={eyebrow}
          entity={entity}
          actions={actions}
          heroActions={detail?.heroActions}
          compact={list?.compact}
          decoration={list?.decoration}
          listChrome={listChrome}
          workbenchControls={list?.workbenchControls}
          mobileTitleVisible={list?.mobileTitleVisible}
          heroStamp={detail?.heroStamp}
          heroStats={detail?.heroStats}
          heroNo={detail?.heroNo}
          heroImages={detail?.heroImages}
          heroMedia={detail?.heroMedia}
          rawData={detail?.rawData}
          count={variant === "list" ? count : undefined}
        />
        <PageIdentityContext.Provider value={identity}>
          <PageDetailContext.Provider
            value={
              detail
                ? {
                    entity: detail.entity,
                    rawData: detail.rawData,
                    heroMedia: detail.heroMedia,
                  }
                : undefined
            }
          >
            <PageCountContext.Provider value={setCount}>
              <Suspense fallback={<ListLoadingSkeleton label={loadingLabel} />}>
                {/* List pages that render several top-level regions (the home
                  dashboard) previously stacked them flush — every region
                  boundary measured 0px, so five separate arguments read as one
                  run-on sentence. DESIGN.md reserves the 2rem step for major
                  region clearance. A no-op for the usual single-child list
                  page, which is why this sits on the children and not on the
                  wrapper the header shares. */}
                <div
                  className={[
                    variant === "list" ? "space-y-2 md:space-y-8" : undefined,
                    variant === "list" && bodyGutter === "standard"
                      ? "px-2 md:px-6"
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {children}
                </div>
              </Suspense>
            </PageCountContext.Provider>
          </PageDetailContext.Provider>
        </PageIdentityContext.Provider>
      </div>
    </PageWrapper>
  );
}
