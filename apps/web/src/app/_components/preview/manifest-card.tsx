import type { Entity } from "@cubby/schemas/entity";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { match } from "ts-pattern";

import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Eyebrow } from "~/components/ui/eyebrow";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";
import {
  type EntityDetailRoute,
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "../entity-media/entity-display-images";
import { EntityInlineLink } from "../EntityInlineLink";
import { NutrientsSummary } from "../units/NutrientsSummary";

// The single "manifest" hovercard renderer. Every entity preview is expressed
// as a declarative ManifestCardProps (built by a per-entity toXCard spec) and
// rendered here — shared header (icon · name · Open · type tag · identity),
// a navigation cross-link strip, then a body of declarative blocks. Mirrors the
// Problems page (one ProblemSection renderer + per-type renderItem shapes).

// ── Declarative shape ───────────────────────────────────────────────────────

type CrossLinkSearchValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | readonly number[];

export type CrossLink = {
  to: EntityDetailRoute;
  // `{ id }` covers usda-food — the one detail route that stays keyed on
  // something other than a shortcode (`String(fdc_id)`); every other entity's
  // route wants `{ shortcode }` containing its canonical public id.
  params: { id: string } | { shortcode: string };
  search?: Readonly<Record<string, CrossLinkSearchValue>>;
  /** Leading icon — the target entity's icon (or a view icon for self-views). */
  icon?: ReactNode;
  label: string;
};

export type BodyBlock =
  | { kind: "thumb"; url: string }
  | { kind: "nutrients"; nutrients: Record<string, number>; label?: string }
  | {
      kind: "stats";
      stats: { label: string; value: ReactNode; caption?: string }[];
    }
  | {
      kind: "products";
      products: {
        id: string;
        name: string;
        manufacturer: string;
      }[];
    };

export type ManifestCardProps = {
  /** Drives the Open link's route via the entities registry. */
  entity: Entity;
  /** `id` param for the Open link. */
  routeParam: string;
  icon: ReactNode;
  name: string;
  tag: string;
  identity?: ReactNode;
  crossLinks?: CrossLink[];
  body?: BodyBlock[];
  /** Inspector headers already own the canonical detail action. */
  showOpenAction?: boolean;
  /** Inspector headers own the record identity; keep the body facts only. */
  showIdentityHeader?: boolean;
};

const actionLink =
  "inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-primary hover:underline";
const openIcon =
  "shrink-0 text-primary transition-colors hover:text-primary/70";

export function ManifestCard({
  entity,
  routeParam,
  icon,
  name,
  tag,
  identity,
  crossLinks,
  body,
  showOpenAction = true,
  showIdentityHeader = true,
}: ManifestCardProps) {
  return (
    <div className="flex flex-col gap-2">
      {showIdentityHeader ? (
        <Row align="start" gap="sm">
          <span
            className="mt-0.5 shrink-0 self-start" /* tight: icon optical-align nudge */
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <Row align="start" gap="sm">
              <span className="min-w-0 flex-1 font-heading text-sm leading-tight font-medium">
                {name}
              </span>
              <Row align="center" gap="sm" className="mt-px shrink-0">
                {showOpenAction && entity === "usda-food" ? (
                  <Link
                    to="/usda/$id"
                    params={{ id: routeParam }}
                    aria-label="Open"
                    className={openIcon}
                  >
                    <ArrowUpRightIcon className="size-3.5" />
                  </Link>
                ) : showOpenAction && isBrowserRoutedEntity(entity) ? (
                  <Link
                    to={entities[entity].routes.detail}
                    params={entityDetailParams(routeParam)}
                    aria-label="Open"
                    className={openIcon}
                  >
                    <ArrowUpRightIcon className="size-3.5" />
                  </Link>
                ) : null}
                <span className="rounded-sm bg-muted px-2 py-px font-mono text-2xs tracking-wide text-muted-foreground uppercase">
                  {tag}
                </span>
              </Row>
            </Row>
            {identity && (
              <Row
                align="center"
                gap="sm"
                className="mt-1 text-xs text-muted-foreground"
              >
                {identity}
              </Row>
            )}
          </div>
        </Row>
      ) : null}
      {crossLinks && crossLinks.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-y border-dashed border-border/60 py-2 text-xs">
          {crossLinks.map((cl) => (
            <Link
              key={cl.label}
              to={cl.to}
              params={cl.params}
              // SAFETY: each cross-link owns a matching route/search pair;
              // their heterogeneous union loses that correlation here.
              // TanStack can't statically validate search across a route union.
              search={cl.search as never}
              className={actionLink}
            >
              {cl.icon}
              {cl.label}
            </Link>
          ))}
        </div>
      )}
      {body?.map((block, index) => (
        <BodyBlockView
          // oxlint-disable-next-line react/no-array-index-key -- Manifest body blocks are a fixed positional presentation list without stable ids.
          key={index}
          block={block}
        />
      ))}
    </div>
  );
}

// ── Body blocks ─────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return <Eyebrow as="span">{children}</Eyebrow>;
}

function BodyBlockView({ block }: { block: BodyBlock }) {
  const productRefs = useMemo(
    () =>
      block.kind === "products"
        ? block.products.slice(0, 4).map((product) => ({
            entityType: "product" as const,
            entityId: product.id,
          }))
        : [],
    [block],
  );
  const displayImages = useEntityDisplayImages(productRefs);
  return match(block)
    .with({ kind: "thumb" }, (b) => (
      <Image
        src={b.url}
        alt=""
        displayWidth={300}
        className="h-24 w-full rounded-md border border-border bg-card object-contain"
      />
    ))
    .with({ kind: "nutrients" }, (b) => (
      <div className="flex flex-col gap-1">
        <SectionLabel>{b.label ?? "Per 100g"}</SectionLabel>
        <NutrientsSummary nutrients={b.nutrients} dense />
      </div>
    ))
    .with({ kind: "stats" }, (b) => (
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {b.stats.map((s) => (
          <div key={s.label} className="flex flex-col">
            <SectionLabel>{s.label}</SectionLabel>
            <span className="text-sm font-medium tabular-nums">{s.value}</span>
            {s.caption && (
              <span className="font-mono text-2xs text-muted-foreground">
                {s.caption}
              </span>
            )}
          </div>
        ))}
      </div>
    ))
    .with({ kind: "products" }, (b) => (
      <div className="flex flex-col gap-1">
        <SectionLabel>Product{b.products.length === 1 ? "" : "s"}</SectionLabel>
        <div className="flex flex-col gap-1">
          {b.products.slice(0, 4).map((p) => (
            <EntityInlineLink
              displayImage={
                displayImages[
                  entityDisplayImageKey({
                    entityType: "product",
                    entityId: p.id,
                  })
                ] ?? null
              }
              key={p.id}
              entity="product"
              data={p}
              compact
            />
          ))}
          {b.products.length > 4 && (
            <Description as="span" size="2xs">
              +{b.products.length - 4} more
            </Description>
          )}
        </div>
      </div>
    ))
    .exhaustive();
}

// ── Shared bits used by per-entity specs / fetch wrappers ────────────────────

/** A per-each price figure, e.g. "from $1.99/ea". */
export function PriceValue({
  amount,
  from,
}: {
  amount: number;
  from?: boolean;
}) {
  return (
    <>
      {from && <span className="text-xs text-muted-foreground">from </span>}
      {formatCurrency(amount)}
      <span className="text-xs text-muted-foreground">/ea</span>
    </>
  );
}

export function PreviewLoading() {
  return (
    <Row align="center" justify="center" className="py-4">
      <Spinner className="text-muted-foreground" />
    </Row>
  );
}

export function PreviewDeleted({ label }: { label: string }) {
  return (
    <span className="text-sm text-muted-foreground italic">
      {label} (deleted)
    </span>
  );
}
