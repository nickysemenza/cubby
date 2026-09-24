import { PlusIcon as Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import {
  type CSSProperties,
  type FC,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

export interface ChipsInputProps {
  id?: string;
  value: string[] | null;
  onChange: (values: string[]) => void;
  className?: string;
  placeholder?: string;
  /** Focus the text input on mount. Opt-in — used by the inline cell editor so
   * it opens ready to type; the recipe form leaves it off. */
  focusOnMount?: boolean;
  /** Seed the text input with an initial value (type-to-edit: the character
   * that opened the editor starts a NEW chip; existing chips are kept). */
  initialInputValue?: string;
  /** Enter with an EMPTY input (Enter otherwise adds a chip). Opt-in — the
   * inline cell editor commits on it (type tag → Enter chips it → Enter
   * again saves); the recipe form leaves Enter-on-empty a no-op. */
  onEmptyEnter?: () => void;
  /** Transform raw typed/pasted text before adding. Default: trim only — pass
   * e.g. `(s) => s.trim().toLowerCase()` for a case-normalized vocabulary
   * (recipe tags). Return "" to reject the input (no-op). */
  normalize?: (raw: string) => string;
  /** Custom chip visuals (icon/color/etc). Default: plain text. The remove
   * ("x") button is always rendered by the base component. */
  renderChip?: (value: string) => ReactNode;
  /** Per-chip className override (e.g. a themed border color class). */
  chipClassName?: (value: string) => string | undefined;
  /** Per-chip inline style (e.g. recipe tag prefix border/tint colors, which
   * are computed at runtime — not expressible as a static className). */
  chipStyle?: (value: string) => CSSProperties | undefined;
  /**
   * Suggestions to show below the input while typing, recomputed from the
   * current input value on every keystroke. The base component filters out
   * values already added. Omit entirely for no suggestions dropdown.
   */
  getSuggestions?: (inputValue: string) => string[];
  /** Custom suggestion row visuals. Default: plain text. */
  renderSuggestion?: (suggestion: string) => ReactNode;
  /**
   * Handle a suggestion click. Default: add it as a chip. Return `true` to
   * mark it fully handled (skip the default add) — e.g. a prefix suggestion
   * that fills the input instead of adding a chip outright.
   */
  onSuggestionClick?: (
    suggestion: string,
    helpers: {
      setInputValue: (v: string) => void;
      addTag: (v: string) => void;
    },
  ) => boolean | undefined;
}

const defaultNormalize = (raw: string) => raw.trim();

function isDomNode(value: EventTarget | null): value is Node {
  return value instanceof Node;
}

/**
 * Theme-agnostic chips (tag-pills) input: type + Enter/comma/button to add, x
 * to remove, optional filtered suggestions dropdown. Owns state/keyboard/
 * outside-click behavior; visuals (chip content, suggestion rows) and the
 * suggestion corpus are fully injectable so themed wrappers (recipe's
 * prefix-colored `TagInput`) and plain ones (project `locations`) share one
 * implementation. See `recipe-form/tag-input.tsx` for the themed wrapper.
 */
export const ChipsInput: FC<ChipsInputProps> = ({
  id,
  value,
  onChange,
  className,
  placeholder = "Add value...",
  focusOnMount,
  initialInputValue,
  onEmptyEnter,
  normalize = defaultNormalize,
  renderChip,
  chipClassName,
  chipStyle,
  getSuggestions,
  renderSuggestion,
  onSuggestionClick,
}) => {
  const tags = value ?? [];
  const [inputValue, setInputValue] = useState(initialInputValue ?? "");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
  }, [focusOnMount]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        (!isDomNode(event.target) ||
          !containerRef.current.contains(event.target))
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const addTag = (raw: string) => {
    const normalized = normalize(raw);
    if (normalized && !tags.includes(normalized)) {
      onChange([...tags, normalized]);
    }
    setInputValue("");
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  const removeTag = (tagToRemove: string) => {
    onChange(tags.filter((t) => t !== tagToRemove));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (inputValue.trim()) addTag(inputValue);
      else onEmptyEnter?.();
    } else if (e.key === "Backspace" && !inputValue && tags.length > 0) {
      removeTag(tags[tags.length - 1]!);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  const suggestions = (getSuggestions?.(inputValue) ?? []).filter(
    (s) => !tags.includes(s),
  );

  return (
    <Stack ref={containerRef} gap="sm" className={className}>
      {tags.length > 0 && (
        <Row wrap gap="xs">
          {tags.map((tag) => (
            <Badge
              key={tag}
              variant="outline"
              className={cn(
                // Free-form user-entered chips — opt out of the mono-uppercase stamp.
                "gap-1 pr-1 font-sans font-normal tracking-normal normal-case",
                chipClassName?.(tag),
              )}
              style={chipStyle?.(tag)}
            >
              {renderChip ? renderChip(tag) : <span>{tag}</span>}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="ml-1 rounded hover:bg-muted"
              >
                <X size={12} />
              </button>
            </Badge>
          ))}
        </Row>
      )}

      <div className="relative">
        <Row gap="sm">
          <Input
            id={id}
            ref={inputRef}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => inputValue.trim() && addTag(inputValue)}
            disabled={!inputValue.trim()}
          >
            <Plus className="size-4" />
          </Button>
        </Row>

        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-50 mt-1 w-full border bg-popover p-1">
            {suggestions.map((suggestion) => (
              <Row
                as="button"
                key={suggestion}
                type="button"
                align="center"
                gap="sm"
                onClick={() => {
                  const handled = onSuggestionClick?.(suggestion, {
                    setInputValue: (v) => {
                      setInputValue(v);
                      inputRef.current?.focus();
                    },
                    addTag,
                  });
                  if (!handled) addTag(suggestion);
                }}
                className="w-full rounded px-2 py-2 text-left text-sm hover:bg-accent"
              >
                {renderSuggestion ? (
                  renderSuggestion(suggestion)
                ) : (
                  <span>{suggestion}</span>
                )}
              </Row>
            ))}
          </div>
        )}
      </div>
    </Stack>
  );
};
