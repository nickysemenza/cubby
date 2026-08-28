import type { InfLocation } from "@cubby/schemas/location";
import type * as React from "react";

import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { cn } from "~/lib/utils";

import { LocationIcon } from "./location-icons";

interface LocationTreeRowProps extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
  location: Pick<InfLocation, "name" | "type" | "product">;
  depth: number;
  primaryMeta?: React.ReactNode;
  secondaryMeta?: React.ReactNode;
  trailing?: React.ReactNode;
  leading?: React.ReactNode;
  icon?: React.ReactNode;
  showBranch?: boolean;
  active?: boolean;
  faded?: boolean;
  compact?: boolean;
}

export function LocationTreeRow({
  ref,
  location,
  depth,
  primaryMeta,
  secondaryMeta,
  trailing,
  leading,
  icon,
  showBranch = true,
  active = false,
  faded = false,
  compact = false,
  className,
  ...props
}: LocationTreeRowProps) {
  return (
    <Row
      ref={ref}
      align="center"
      gap="sm"
      className={cn(
        "group/tree-row min-w-0",
        active && "bg-primary/5 text-primary",
        faded && "opacity-40",
        className,
      )}
      {...props}
    >
      <div
        className="flex shrink-0 items-center"
        style={{
          width: `${Math.max(depth, 0) * (compact ? 1 : 1.25) + (compact ? 1 : 1.25)}rem`,
        }}
        aria-hidden="true"
      >
        {showBranch && depth > 0 && (
          <div
            className={cn(
              "ml-auto w-4 border-b border-l border-[var(--border)]",
              compact ? "h-6" : "h-8",
            )}
          />
        )}
      </div>
      {leading}
      {icon ?? (
        <LocationIcon
          type={location.type}
          product={location.product}
          size={16}
        />
      )}
      <div className="min-w-0 flex-1 space-y-0.5" /* tight: compact tree row */>
        <div
          className="flex min-w-0 items-baseline gap-1.5" /* tight: compact tree row */
        >
          <span
            data-slot="tree-row-title"
            title={location.name}
            className={cn(
              "truncate font-medium",
              compact ? "text-xs" : "text-sm",
            )}
          >
            {location.name}
          </span>
          {primaryMeta && (
            <Description as="span" size="2xs" className="shrink-0">
              · {primaryMeta}
            </Description>
          )}
        </div>
        {secondaryMeta && (
          <Description
            data-slot="tree-row-meta"
            size={compact ? "2xs" : "xs"}
            className="truncate"
          >
            {secondaryMeta}
          </Description>
        )}
      </div>
      {trailing}
    </Row>
  );
}
