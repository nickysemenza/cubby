import type { Entity } from "@cubby/schemas/entity";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  EntityIcon,
  entities,
  isBrowserRoutedEntity,
} from "~/entities/entities";

interface EntityStatProps {
  entity: Entity;
  count: number;
  /** Show label after count. `true` for auto-label from entity pluralLabel, or a custom string. */
  label?: boolean | string;
  /** Show tooltip on hover. `true` for auto-tooltip, or a custom string. */
  tooltip?: boolean | string;
  iconSize?: number;
}

function isCustomText(value: boolean | string): value is string {
  return typeof value === "string";
}

function getLabel(entity: Entity, count: number, label: boolean | string) {
  if (isCustomText(label)) return label;
  if (!isBrowserRoutedEntity(entity)) return entity;
  const def = entities[entity];
  return count === 1 ? def.label.toLowerCase() : def.pluralLabel.toLowerCase();
}

function getTooltipText(
  entity: Entity,
  count: number,
  tooltip: boolean | string,
) {
  if (isCustomText(tooltip)) return tooltip;
  if (!isBrowserRoutedEntity(entity)) return `${count} ${entity}`;
  const def = entities[entity];
  const noun =
    count === 1 ? def.label.toLowerCase() : def.pluralLabel.toLowerCase();
  return `${count} ${noun}`;
}

export function EntityStat({
  entity,
  count,
  label,
  tooltip,
  iconSize = 12,
}: EntityStatProps) {
  const content = (
    <div className="flex items-center gap-1">
      <EntityIcon entity={entity} size={iconSize} />
      <span>{count}</span>
      {label && <span>{getLabel(entity, count, label)}</span>}
    </div>
  );

  if (!tooltip) return content;

  return (
    <Tooltip>
      <TooltipTrigger render={content} />
      <TooltipContent>{getTooltipText(entity, count, tooltip)}</TooltipContent>
    </Tooltip>
  );
}
