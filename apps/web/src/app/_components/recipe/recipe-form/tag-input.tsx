import type { FC } from "react";

import { ChipsInput } from "~/app/_components/forms/chips-input";
import { useTagOptions } from "~/app/_components/hooks/useEntityOptions";
import { Description } from "~/components/ui/description";

import {
  getTagColor,
  getTagIcon,
  getTagTint,
  parseTag,
  TAG_PREFIXES,
} from "../tag-theme";

interface TagInputProps {
  id?: string;
  value: string[] | null;
  onChange: (tags: string[]) => void;
  className?: string;
  /** Focus the input on mount (inline cell editor opens ready to type). */
  focusOnMount?: boolean;
  /** Seed the input with an initial value (type-to-edit). */
  initialInputValue?: string;
  /** Enter with an empty input (the inline cell editor commits on it). */
  onEmptyEnter?: () => void;
}

/**
 * Tag input with autocomplete for recipe tags — a themed wrapper around the
 * generic {@link ChipsInput}: recipe-tag-specific normalization (lowercase),
 * prefix/color/icon theming (`tag-theme.ts`), and suggestions sourced from
 * `useTagOptions("recipe")` plus the known `TAG_PREFIXES`. Supports prefixed tags
 * like "cuisine:thai" or plain tags like "quick" — same behavior/visuals as
 * before the `ChipsInput` extraction.
 */
export const TagInput: FC<TagInputProps> = ({
  id,
  value,
  onChange,
  className,
  focusOnMount,
  initialInputValue,
  onEmptyEnter,
}) => {
  const tags = value ?? [];
  const { options: existingTagOptions } = useTagOptions("recipe");
  const existingTags = existingTagOptions.map((option) => option.value);

  const getSuggestions = (inputValue: string): string[] => {
    const input = inputValue.toLowerCase();
    if (input.length === 0) return [];
    const suggestions: string[] = [];

    // Suggest prefixes if input matches start of a prefix
    for (const prefix of TAG_PREFIXES) {
      if (prefix.startsWith(input)) suggestions.push(`${prefix}:`);
    }

    // Add matching existing tags
    if (existingTags) {
      for (const t of existingTags) {
        if (
          t.includes(input) &&
          !tags.includes(t) &&
          !suggestions.includes(t)
        ) {
          suggestions.push(t);
        }
      }
    }

    return suggestions.slice(0, 8);
  };

  return (
    <ChipsInput
      id={id}
      value={value}
      onChange={onChange}
      className={className}
      focusOnMount={focusOnMount}
      initialInputValue={initialInputValue}
      onEmptyEnter={onEmptyEnter}
      placeholder="Add tag (e.g., cuisine:thai, quick)"
      normalize={(raw) => raw.trim().toLowerCase()}
      getSuggestions={getSuggestions}
      renderChip={(tag) => {
        const { prefix } = parseTag(tag);
        const Icon = getTagIcon(prefix);
        const color = getTagColor(prefix);
        return (
          <>
            <Icon size={12} style={{ color }} className="shrink-0" />
            <span>{tag}</span>
          </>
        );
      }}
      chipStyle={(tag) => {
        const { prefix } = parseTag(tag);
        return {
          borderColor: getTagColor(prefix),
          backgroundColor: getTagTint(prefix),
        };
      }}
      renderSuggestion={(suggestion) => {
        const { prefix } = parseTag(suggestion);
        const Icon = getTagIcon(prefix);
        const color = getTagColor(prefix);
        const isPrefix = suggestion.endsWith(":");
        return (
          <>
            <Icon size={14} style={{ color }} />
            <span>{suggestion}</span>
            {isPrefix && (
              <Description as="span" size="xs">
                type value...
              </Description>
            )}
          </>
        );
      }}
      onSuggestionClick={(suggestion, { setInputValue }) => {
        // A prefix suggestion (e.g. "cuisine:") fills the input for the user
        // to keep typing the value, rather than being added as a chip outright.
        if (suggestion.endsWith(":")) {
          setInputValue(suggestion);
          return true;
        }
        return false;
      }}
    />
  );
};
