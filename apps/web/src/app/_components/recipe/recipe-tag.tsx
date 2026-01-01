import { X } from "lucide-react";
import type { FC } from "react";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import {
  getTagColor,
  getTagDisplayLabel,
  getTagIcon,
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
  const displayLabel = getTagDisplayLabel(tag);

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-normal",
        size === "sm" && "px-1.5 py-0 text-xs",
        onRemove && "pr-1",
        className,
      )}
      style={{
        borderColor: color,
        backgroundColor: `${color}15`,
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
          className="ml-0.5 rounded hover:bg-muted"
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
  className?: string;
  size?: "sm" | "default";
}

/**
 * Display a list of recipe tags
 */
export const RecipeTagList: FC<RecipeTagListProps> = ({
  tags,
  onRemove,
  className,
  size = "default",
}) => {
  if (!tags || tags.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {tags.map((tag) => (
        <RecipeTag
          key={tag}
          tag={tag}
          size={size}
          onRemove={onRemove ? () => onRemove(tag) : undefined}
        />
      ))}
    </div>
  );
};
