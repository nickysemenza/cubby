import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { Link, type LinkProps } from "@tanstack/react-router";
import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { EntityIdentityMark } from "~/entity/components/entity-identity-mark";
import { EntityPill } from "~/entity/components/entity-pill";
import type { EntityPreviewContent as EntityPreviewContentComponent } from "~/entity/components/entity-preview-content";
import { RecordMarkByReference } from "~/entity/components/record-mark";
import {
  entities,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
  type EntityDetailParams,
  type EntityDetailRoute,
} from "~/entity/entities";
import { useEntityDisplayImage } from "~/entity/entity-media/entity-display-images";
import {
  hoverPreviewEntities,
  type HoverPreviewEntity,
} from "~/entity/preview/preview-entities";
import { browserOnlyLazy } from "~/lib/browser-only-lazy";
import { cn } from "~/lib/utils";
import { useIdentityCell } from "~/ui/common/stacked-value";
import { ExternalLinkIcon } from "~/ui/external-link";
import {
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
} from "~/ui/primitives/preview-card";
import { Spinner } from "~/ui/primitives/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

const EntityPreviewContent = browserOnlyLazy<
  ComponentProps<typeof EntityPreviewContentComponent>
>(
  import.meta.env.SSR
    ? null
    : () =>
        import("~/entity/components/entity-preview-content").then((module) => ({
          default: module.EntityPreviewContent,
        })),
);

/**
 * Plain-text link styling for the dense recipe views (prep/matrix/nested-spec):
 * a dotted underline that turns solid + primary on hover. Mirrors the inline
 * variant's underline treatment so links read consistently app-wide.
 */
export const dottedEntityLink =
  "underline decoration-border/70 decoration-dotted underline-offset-2 transition-colors hover:text-primary hover:decoration-primary hover:decoration-solid";

// ── preview ────────────────────────────────────────────────────────────────

type PreviewRefLinkProps = {
  entity: HoverPreviewEntity;
  /**
   * The canonical public id used for both navigation and the preview query.
   * For `usda-food` this is `String(fdc_id)`.
   */
  id: string;
  /** The trigger content — a plain name, or a full pill body. */
  children: ReactNode;
  /** Backend-enriched canonical image for this record, or an explicit null. */
  displayImage: ImageUrlSummary | null;
  /** Preserve entity-specific marks while an image decodes or is unavailable. */
  fallbackMark?: ReactNode;
  /** An adjacent image/mark already supplies identity on this surface. */
  showIdentityMark?: boolean;
  openInNewTab?: boolean;
  className?: string;
};

/**
 * A link to a record's detail page that, on hover/focus, opens a compact
 * preview hovercard (lazily fetched). The one place that owns "link +
 * preview": the inline variant and the dense recipe views (plain-text
 * children) both render through it. On touch there is no hover; the tap
 * navigates, so the preview is a pure pointer-device enhancement.
 */
export function PreviewRefLink({
  entity,
  id,
  children,
  displayImage,
  fallbackMark,
  showIdentityMark = true,
  openInNewTab,
  className,
}: PreviewRefLinkProps) {
  const linkClass = cn(
    showIdentityMark && "inline-flex items-center gap-1",
    className,
  );
  const newTab = openInNewTab
    ? ({ target: "_blank", rel: "noopener noreferrer" } as const)
    : {};
  return (
    <PreviewCard>
      <PreviewCardTrigger
        // Open a touch faster than the 600ms default; close promptly.
        delay={300}
        closeDelay={150}
        render={
          // usda-food is the one HoverPreviewEntity that isn't shortcode-keyed
          // (its route stays `/usda/$id`, keyed on `String(fdc_id)`).
          entity === "usda-food" ? (
            <Link
              to="/usda/$id"
              params={{ id }}
              className={linkClass}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              {...newTab}
            />
          ) : (
            <Link
              to={entities[entity].routes.detail}
              params={entityDetailParams(id)}
              className={linkClass}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              {...newTab}
            />
          )
        }
      >
        {showIdentityMark && (
          <EntityIdentityMark
            entity={entity}
            displayImage={displayImage ?? null}
            fallback={fallbackMark}
          />
        )}
        {children}
      </PreviewCardTrigger>
      <PreviewCardContent>
        <Suspense
          fallback={
            <div className="flex justify-center py-4">
              <Spinner className="text-muted-foreground" />
            </div>
          }
        >
          <EntityPreviewContent entity={entity} id={id} />
        </Suspense>
      </PreviewCardContent>
    </PreviewCard>
  );
}

// ── table ──────────────────────────────────────────────────────────────────

const tableLinkVariants = cva(
  "rounded-[2px] underline-offset-2 transition-colors outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
  {
    variants: {
      tone: {
        default: "font-medium text-muted-foreground hover:text-primary",
        // Graphite carries hierarchy; cobalt signals interaction. A column of
        // bold cobalt names made every row shout.
        identity: "font-medium text-foreground hover:text-primary",
        mono: "font-mono text-primary",
        muted: "font-medium text-muted-foreground hover:text-foreground",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  },
);

/** USDA lookup routes (not standard entity routes) */
type USDALookupRoute =
  | { to: "/usda/upc/$code"; params: { code: string } }
  | { to: "/usda/ndb/$code"; params: { code: string } };

/**
 * Standard entity detail routes. `params` is the full `EntityDetailParams`
 * union (`{ shortcode }`) for the shortcode-bearing entities, or `{ id }` for
 * `usda-food` — the one entity `EntityDetailRoute` covers whose route
 * (`/usda/$id`) keys on its external `fdc_id` rather than a Cubby shortcode.
 */
type EntityRoute = {
  to: EntityDetailRoute;
  params: EntityDetailParams | { id: string };
};

/**
 * What a plain text link names, declared at every call site: `identity` is a
 * row's own name (beside its image column in a table), `mono` a code, and
 * `muted` a related record's name beside its own mark or emoji. A reference to
 * another record with no mark is none of these; it uses `chip`, which carries
 * one.
 */
type TableLinkRole = "identity" | "mono" | "muted";

type TableLinkBase = {
  children: ReactNode;
  className?: string;
  title?: string;
} & (USDALookupRoute | EntityRoute);

/**
 * A plain styled link for a table cell. It stops the click so a clickable row
 * never also navigates to its own destination. The chip and avatar variants
 * reuse it untoned around their own mark.
 */
export function TableRefLink({
  to,
  params,
  children,
  className = "",
  title,
  tone,
}: { tone?: TableLinkRole } & TableLinkBase) {
  return (
    <Link
      className={tableLinkVariants({ tone, className })}
      to={to}
      params={params}
      title={title}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </Link>
  );
}

// ── chip ───────────────────────────────────────────────────────────────────

const isHoverPreviewEntity = (
  entity: BrowserRoutedEntity | "usda-food",
): entity is HoverPreviewEntity =>
  hoverPreviewEntities.some((candidate) => candidate === entity);

type ChipRefLinkProps = {
  entity: BrowserRoutedEntity | "usda-food";
  id: string;
  name: string | null;
  bare?: boolean;
  emoji?: string | null;
  displayImage?: ImageUrlSummary | null;
  className?: string;
  openInNewTab?: boolean;
  /** Declared context remains outside the identity pill. */
  context?: string;
  fallback?: ReactNode;
};

/**
 * A link to one record led by the same image-or-icon identity mark as the
 * inline variant: manifest reference values and field-provenance sources
 * share it so a record reads the same wherever it is named. Outside a
 * provider, the entity icon holds the mark's box.
 */
export function ChipRefLink({
  entity,
  id,
  name,
  displayImage,
  emoji,
  bare,
  className,
  openInNewTab,
  context,
  fallback,
}: ChipRefLinkProps) {
  const identityCell = useIdentityCell();
  const identity = bare ?? identityCell;
  const label = name ?? id;
  const providedImage = useEntityDisplayImage({
    entityKind: entity,
    entityId: id,
  });
  const image = displayImage === undefined ? providedImage : displayImage;
  const content = identity ? (
    <span className="min-w-0 truncate">{label}</span>
  ) : (
    <EntityPill
      entity={entity}
      id={id}
      name={label}
      displayImage={image}
      emoji={emoji}
      fallback={
        <RecordMarkByReference
          entity={entity}
          recordId={id}
          emoji={emoji}
          size={12}
          fallback={fallback}
        />
      }
    />
  );
  return isHoverPreviewEntity(entity) ? (
    <PreviewRefLink
      entity={entity}
      id={id}
      displayImage={image}
      showIdentityMark={false}
      className={tableLinkVariants({
        tone: identity ? "identity" : undefined,
        className: cn(
          "inline-flex max-w-full min-w-0 items-center gap-1 align-middle",
          className,
        ),
      })}
      openInNewTab={openInNewTab}
    >
      {content}
      {!identity && context && (
        <span className="min-w-0 truncate text-2xs text-muted-foreground">
          {" "}
          · {context}
        </span>
      )}
    </PreviewRefLink>
  ) : (
    <TableRefLink
      to={entities[entity].routes.detail}
      params={entityDetailParams(id)}
      title={label}
      tone={identity ? "identity" : undefined}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 align-middle",
        className,
      )}
    >
      {content}
    </TableRefLink>
  );
}

// ── audit ──────────────────────────────────────────────────────────────────

type AuditRefLinkProps = {
  entityKind: Entity;
  entityId: string;
  name?: string | null;
  displayImage: ImageUrlSummary | null;
  compact?: boolean;
  className?: string;
};

/**
 * Audit rows already carry public shortcodes. Link them directly instead of
 * sending those shortcodes through a name resolver.
 *
 * The name leads and the code trails as a quiet mono stamp: a feed of rows
 * reading only the entity type and its code told the reader nothing about
 * which thing moved.
 *
 * `name` is optional because resolution can genuinely come back empty — a
 * purchase whose only name-shaped column is unset, or a row whose name source
 * no longer resolves. The type-plus-code shape survives as that fallback.
 */
export function AuditRefLink({
  entityKind,
  entityId,
  name,
  displayImage,
  compact,
  className: classNameProp,
}: AuditRefLinkProps) {
  const label = entityLabel(entityKind);
  const title = name ? `${name} · ${entityId}` : `${label} ${entityId}`;
  const content = (
    <>
      {name ? (
        <>
          <EntityPill
            entity={entityKind}
            id={entityId}
            name={name}
            displayImage={displayImage}
          />
          <span className="shrink-0 text-xs font-medium text-slate">
            {entityId}
          </span>
        </>
      ) : (
        <span className={cn(compact && "truncate")}>
          {label} <span className="font-mono text-xs">{entityId}</span>
        </span>
      )}
    </>
  );

  const className = cn(
    // Fills the ledger row's height on phones so the tap target is the row
    // the reader is aiming at, not the 20px of text inside it.
    "inline-flex min-h-11 min-w-0 items-center gap-2 text-sm font-medium text-primary sm:min-h-0",
    compact && "max-w-48 sm:max-w-72",
    classNameProp,
  );

  if (!isBrowserRoutedEntity(entityKind)) {
    return (
      <span className={className} title={title}>
        {content}
      </span>
    );
  }

  return (
    <Link
      to={entities[entityKind].routes.detail}
      params={entityDetailParams(entityId)}
      className={cn(className, "hover:underline")}
      title={title}
    >
      {content}
    </Link>
  );
}

// ── filter ─────────────────────────────────────────────────────────────────

type FilterRefLinkProps = LinkProps & {
  /** Accessible action text, also shown in the icon display's tooltip. */
  label: string;
  /** Wrap a readable value, or render the secondary filter action beside it. */
  display?: "value" | "icon";
  children?: ReactNode;
  className?: string;
};

/**
 * Navigate from one entity's reusable metadata to the matching filtered list.
 *
 * Read-only facets use `value`, making the displayed text/chip the link.
 * Editable values and entity relationships keep their primary interaction and
 * place the `icon` display beside it instead, so controls are never nested.
 */
export function FilterRefLink({
  label,
  display = "icon",
  children,
  className,
  ...linkProps
}: FilterRefLinkProps) {
  if (display === "value") {
    return (
      <Link
        {...linkProps}
        aria-label={label}
        className={cn(
          "group/filter inline-flex max-w-full items-center text-primary underline decoration-border/70 decoration-dotted underline-offset-2 transition-colors hover:decoration-primary hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          className,
        )}
      >
        {children}
      </Link>
    );
  }

  const link = (
    <Link
      {...linkProps}
      aria-label={label}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-7",
        className,
      )}
    >
      <FunnelIcon className="size-3.5" />
    </Link>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// ── order ──────────────────────────────────────────────────────────────────

type OrderRefLinkProps = {
  orderUrl: string | null | undefined;
  orderId: string | null | undefined;
  vendorName?: string | null;
};

/**
 * The link out to a vendor's own order page for a purchase's order id.
 *
 * `orderUrl` is derived server-side from the vendor's `orderUrlTemplate`
 * (`purchaseOrderUrl`), so null here means one of: the vendor has no template,
 * the purchase has no order id, or the id is a synthetic import key that no
 * template can resolve. All three render as nothing rather than as a dead link.
 *
 * Deliberately an icon *beside* the id rather than a link *on* it: every
 * surface that shows an order id either edits it inline or sits in a clickable
 * table row, and both of those own the click on the text itself.
 */
export function OrderRefLink({
  orderUrl,
  orderId,
  vendorName,
}: OrderRefLinkProps) {
  if (!orderUrl) return null;
  return (
    <ExternalLinkIcon
      href={orderUrl}
      label={`Open order ${orderId ?? ""} at ${vendorName ?? "the vendor"}`.trim()}
    />
  );
}
