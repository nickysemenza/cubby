import { type FC, type KeyboardEvent, useEffect, useState } from "react";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

interface QuantityInputProps {
  /** The numeric quantity, or null when empty. */
  value: number | null;
  /** Called on blur/Enter with the parsed number, or null when cleared. */
  onChange: (value: number | null) => void;
  /** Fired after a successful commit when Enter is pressed (e.g. append a row). */
  onEnter?: () => void;
  className?: string;
  /** Forwarded to the input so a `<label htmlFor>` can associate with it. */
  id?: string;
  "aria-label"?: string;
  placeholder?: string;
}

/**
 * A text quantity field that displays fractions and parses them back. The stored
 * value is a plain `number` (e.g. `0.333…`); this renders it as an editable ASCII
 * fraction (`1/3`, `1 1/2`) via {@link wasm.format_quantity} and parses `1/3` / `⅓`
 * / `1 1/2` / decimals back via {@link wasm.parse_quantity} on blur/Enter — so an
 * imported `1/3 cup` reads as `1/3`, not `0.333333333333`.
 *
 * Intentionally not coupled to react-hook-form: wrap it in a `Controller` (the
 * recipe editor) or drive it with `useState` (the design gallery). WASM is touched
 * only on mount + commit, never per keystroke — typing edits local string state.
 */
export const QuantityInput: FC<QuantityInputProps> = ({
  value,
  onChange,
  onEnter,
  className,
  id,
  "aria-label": ariaLabel,
  placeholder,
}) => {
  const [text, setText] = useState(() =>
    value != null ? wasm.format_quantity(value) : "",
  );
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // Resync from the external value when not actively editing and the last commit
  // parsed cleanly — so a re-parse that rewrites the form value reflows in, while a
  // typed-but-unparseable value is retained for the user to fix (see `commit`).
  useEffect(() => {
    if (!focused && !invalid) {
      setText(value != null ? wasm.format_quantity(value) : "");
    }
  }, [value, focused, invalid]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      setInvalid(false);
      onChange(null);
      return;
    }
    try {
      const parsed = wasm.parse_quantity(trimmed);
      setInvalid(false);
      setText(wasm.format_quantity(parsed)); // normalize "0.5" → "1/2"
      onChange(parsed);
    } catch {
      setInvalid(true); // keep the typed text; surface it as invalid
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      onEnter?.();
    }
  };

  return (
    <Input
      type="text"
      inputMode="text"
      id={id}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      placeholder={placeholder}
      className={cn("text-right font-mono tabular-nums", className)}
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        setInvalid(false);
        setText(e.target.value);
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={handleKeyDown}
    />
  );
};
