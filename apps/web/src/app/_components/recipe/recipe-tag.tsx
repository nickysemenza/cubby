import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import type { FC } from "react";

import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { cn } from "~/lib/utils";

import {
  getTagColor,
  getTagDisplayLabel,
  getTagIcon,
  getTagTint,
  parseTag,
} from "./tag-theme";

interface RecipeTagProps {
  tag: string;
  onRemove?: () => void;
  className?: string;
  size?: "sm" | "default";
}

/**
 * Display a recipe tag with colored icon based on prefix
 */
export const RecipeTag: FC<RecipeTagProps> = ({
  tag,
  onRemove,
  className,
  size = "default",
}) => {
  const { prefix } = parseTag(tag);
  const Icon = getTagIcon(prefix);
  const color = getTagColor(prefix);
  const tint = getTagTint(prefix);
  const displayLabel = getTagDisplayLabel(tag);

  return (
    <Badge
      variant="outline"
      className={cn(
        // User-entered tag text — opt out of the badge's mono-uppercase stamp.
        "gap-1 font-sans font-normal tracking-normal normal-case",
        size === "sm" && "px-2 py-0 text-xs",
        onRemove && "pr-1",
        className,
      )}
      style={{
        borderColor: color,
        backgroundColor: tint,
      }}
    >
      <Icon
        size={size === "sm" ? 10 : 12}
        style={{ color }}
        className="shrink-0"
      />
      {prefix !== "none" && (
        <span className="text-muted-foreground">{prefix}:</span>
      )}
      <span>{displayLabel}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="ml-1 rounded hover:bg-muted"
        >
          <X size={size === "sm" ? 10 : 12} />
        </button>
      )}
    </Badge>
  );
};

interface RecipeTagListProps {
  tags: string[];
  onRemove?: (tag: string) => void;
  filterable?: boolean;
  className?: string;
  size?: "sm" | "default";
}

/**
 * Display a list of recipe tags
 */
export const RecipeTagList: FC<RecipeTagListProps> = ({
  tags,
  onRemove,
  filterable = false,
  className,
  size = "default",
}) => {
  if (!tags || tags.length === 0) return null;

  return (
    <Row wrap gap="xs" className={className}>
      {tags.map((tag) => {
        const rendered = (
          <RecipeTag
            key={tag}
            tag={tag}
            size={size}
            onRemove={onRemove ? () => onRemove(tag) : undefined}
          />
        );
        return filterable && !onRemove ? (
          <EntityFilterLink
            key={tag}
            to="/recipes"
            search={{ tags: tag }}
            label={`Show all recipes tagged ${tag}`}
            variant="value"
            className="no-underline"
          >
            {rendered}
          </EntityFilterLink>
        ) : (
          <span key={tag}>{rendered}</span>
        );
      })}
    </Row>
  );
};
