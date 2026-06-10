import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { entities } from "~/entities/entities";
import { ENTITY_ACCENTS } from "~/entities/entity-accents";
import type { Entity } from "~/entities/types";
import { cn } from "~/lib/utils";

const heroVariants = cva(
  "flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between",
  {
    variants: {
      variant: {
        list: "mb-4",
        detail: "mb-3 sm:mb-4",
        compact: "mb-2",
      },
    },
    defaultVariants: { variant: "list" },
  },
);

const titleVariants = cva("break-words font-heading tracking-tight", {
  variants: {
    variant: {
      list: "font-semibold text-3xl",
      detail: "font-bold text-3xl sm:text-4xl lg:text-5xl",
      compact: "font-bold text-2xl",
    },
  },
  defaultVariants: { variant: "list" },
});

interface PageHeroMetaItem {
  icon?: LucideIcon;
  label: ReactNode;
}

// Entities that live under the "Kitchen" nav group — their eyebrows read as a
// path ("Kitchen / Recipes") to match the ledger-style breadcrumb labels.
const KITCHEN_ENTITIES: ReadonlySet<Entity> = new Set([
  "recipe",
  "cookbook",
  "ingredient",
]);

/**
 * Derive an eyebrow path from the entity when none is given explicitly.
 * Detail pages get the full path ("Kitchen / Recipes"); list pages drop the
 * segment that would just repeat the title (so the Recipes list shows
 * "Kitchen", and the Products list shows nothing).
 */
function deriveEyebrow(entity: Entity, title: ReactNode): string | null {
  const def = entities[entity];
  const segments = KITCHEN_ENTITIES.has(entity)
    ? ["Kitchen", def.pluralLabel]
    : [def.pluralLabel];
  const filtered = segments.filter((s) => s !== title);
  return filtered.length > 0 ? filtered.join(" / ") : null;
}

interface PageHeroProps extends VariantProps<typeof heroVariants> {
  title: ReactNode;
  /** Small uppercase label above the title (e.g. "Pantry" above "Locations"). */
  eyebrow?: ReactNode;
  /** Bullet-separated meta items below the title. Detail/compact variants render with icons inline. */
  meta?: PageHeroMetaItem[];
  /** Right-aligned action area (typically buttons). */
  actions?: ReactNode;
  /** Optional entity — when set, shows the entity's icon tinted with its color on detail variant. */
  entity?: Entity;
  /** Decoration under title. "accent" applies the terracotta page-header-accent bar. */
  decoration?: "accent" | "none";
  className?: string;
}

export function PageHero({
  title,
  eyebrow,
  meta,
  actions,
  entity,
  variant = "list",
  decoration = "accent",
  className,
}: PageHeroProps) {
  const def = entity ? entities[entity] : null;
  const EntityIconComponent = def?.lucideIcon;
  const showEntityIcon = variant === "detail" && EntityIconComponent && def;
  const showAccent = decoration === "accent" && variant !== "compact";
  const effectiveEyebrow =
    eyebrow ?? (entity ? deriveEyebrow(entity, title) : null);
  // Entity-inked accent bar (falls back to terracotta via the CSS defaults).
  const accent = entity ? ENTITY_ACCENTS[entity] : null;
  const accentStyle = accent
    ? ({
        "--page-accent": accent.base,
        "--page-accent-light": accent.light,
      } as CSSProperties)
    : undefined;

  return (
    <div
      className={cn(heroVariants({ variant }), className)}
      style={accentStyle}
    >
      <div className="min-w-0 flex-1">
        {effectiveEyebrow && (
          <p className="mb-1 font-medium font-mono text-2xs text-eyebrow uppercase tracking-[0.18em]">
            {effectiveEyebrow}
          </p>
        )}
        <div
          className={cn(
            "flex items-center gap-3",
            showAccent && "page-header-accent pb-2",
          )}
        >
          {showEntityIcon && def && EntityIconComponent && (
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg sm:h-11 sm:w-11",
                def.color.bg,
                def.color.text,
              )}
            >
              <EntityIconComponent className="h-5 w-5 sm:h-6 sm:w-6" />
            </span>
          )}
          <h1 className={titleVariants({ variant })}>{title}</h1>
        </div>
        {meta && meta.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-muted-foreground">
            {meta.map((item, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: meta items are positional and have no stable id
                key={i}
                className="inline-flex items-center gap-1.5"
              >
                {item.icon && <item.icon className="h-3 w-3 shrink-0" />}
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex w-full flex-wrap gap-2 sm:w-auto print:hidden">
          {actions}
        </div>
      )}
    </div>
  );
}
