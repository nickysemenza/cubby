import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { type FC, useEffect, useRef, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/trpc/react";
import { getTagColor, getTagIcon, parseTag, TAG_PREFIXES } from "../tag-theme";

interface TagInputProps {
  value: string[] | null;
  onChange: (tags: string[]) => void;
  className?: string;
}

/**
 * Tag input with autocomplete for recipe tags.
 * Supports prefixed tags like "cuisine:thai" or plain tags like "quick"
 */
export const TagInput: FC<TagInputProps> = ({ value, onChange, className }) => {
  const tags = value ?? [];
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLElement>(null);

  // Fetch existing tags for autocomplete
  const api = useTRPC();
  const { data: existingTags } = useQuery(api.recipe.getAllTags.queryOptions());

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const addTag = (tag: string) => {
    const normalizedTag = tag.trim().toLowerCase();
    if (normalizedTag && !tags.includes(normalizedTag)) {
      onChange([...tags, normalizedTag]);
    }
    setInputValue("");
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  const removeTag = (tagToRemove: string) => {
    onChange(tags.filter((t) => t !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (inputValue.trim()) {
        addTag(inputValue);
      }
    } else if (e.key === "Backspace" && !inputValue && tags.length > 0) {
      removeTag(tags[tags.length - 1]!);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  // Generate suggestions based on input
  const getSuggestions = (): string[] => {
    const input = inputValue.toLowerCase();
    const suggestions: string[] = [];

    // Suggest prefixes if input matches start of a prefix
    TAG_PREFIXES.forEach((prefix) => {
      if (prefix.startsWith(input) && input.length > 0) {
        suggestions.push(`${prefix}:`);
      }
    });

    // Add matching existing tags
    if (existingTags && input.length > 0) {
      existingTags
        .filter((t: string) => t.includes(input) && !tags.includes(t))
        .forEach((t: string) => {
          if (!suggestions.includes(t)) {
            suggestions.push(t);
          }
        });
    }

    // Filter out already-added tags
    return suggestions.filter((s) => !tags.includes(s)).slice(0, 8);
  };

  const suggestions = getSuggestions();

  return (
    <Stack ref={containerRef} gap="sm" className={className}>
      {/* Existing tags */}
      {tags.length > 0 && (
        <Row wrap gap="xs">
          {tags.map((tag) => {
            const { prefix } = parseTag(tag);
            const Icon = getTagIcon(prefix);
            const color = getTagColor(prefix);
            return (
              <Badge
                key={tag}
                variant="outline"
                className="gap-1 pr-1 font-normal"
                style={{
                  borderColor: color,
                  backgroundColor: `${color}15`,
                }}
              >
                <Icon size={12} style={{ color }} className="shrink-0" />
                <span>{tag}</span>
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="ml-1 rounded hover:bg-muted"
                >
                  <X size={12} />
                </button>
              </Badge>
            );
          })}
        </Row>
      )}

      {/* Input with suggestions */}
      <div className="relative">
        <Row gap="sm">
          <Input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={handleKeyDown}
            placeholder="Add tag (e.g., cuisine:thai, quick)"
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => inputValue.trim() && addTag(inputValue)}
            disabled={!inputValue.trim()}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </Row>

        {/* Suggestions dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
            {suggestions.map((suggestion) => {
              const { prefix } = parseTag(suggestion);
              const Icon = getTagIcon(prefix);
              const color = getTagColor(prefix);
              const isPrefix = suggestion.endsWith(":");
              return (
                <Row
                  as="button"
                  key={suggestion}
                  type="button"
                  align="center"
                  gap="sm"
                  onClick={() => {
                    if (isPrefix) {
                      setInputValue(suggestion);
                      inputRef.current?.focus();
                    } else {
                      addTag(suggestion);
                    }
                  }}
                  className="w-full rounded px-2 py-2 text-left text-sm hover:bg-accent"
                >
                  <Icon size={14} style={{ color }} />
                  <span>{suggestion}</span>
                  {isPrefix && (
                    <Description as="span" size="xs">
                      type value...
                    </Description>
                  )}
                </Row>
              );
            })}
          </div>
        )}
      </div>
    </Stack>
  );
};
