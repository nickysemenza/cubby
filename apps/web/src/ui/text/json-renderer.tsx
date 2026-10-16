import { useState, type JSX } from "react";
import { z } from "zod";

const jsonValue = z.json();
type JsonValue = z.infer<typeof jsonValue>;

function JsonNode({
  value,
  name,
  expanded = false,
}: {
  value: JsonValue;
  name: string;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(expanded);
  if (value === null || typeof value !== "object") {
    return (
      <div className="flex gap-2">
        <span className="text-muted-foreground">{name}:</span>
        <code className="break-all whitespace-pre-wrap">
          {JSON.stringify(value)}
        </code>
      </div>
    );
  }
  const entries = Object.entries(value);
  const noun = Array.isArray(value) ? "items" : "fields";
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer break-all">
        {name} · {entries.length} {noun}
      </summary>
      {open && (
        <div className="ml-3 border-l border-border pl-2">
          {entries.map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} />
          ))}
        </div>
      )}
    </details>
  );
}

const JsonRenderer = ({
  input,
  pretty = false,
}: {
  input: unknown;
  pretty?: boolean;
}): JSX.Element => {
  const plain = JSON.stringify(input, null, 2);
  // Serialization preserves the existing Date/undefined handling of raw
  // diagnostics before the expandable viewer validates its JSON-only input.
  const parsed =
    pretty && plain !== undefined
      ? jsonValue.safeParse(JSON.parse(plain))
      : null;
  return parsed?.success ? (
    <div className="max-w-full overflow-auto font-mono text-2xs">
      <JsonNode name="JSON" value={parsed.data} expanded />
    </div>
  ) : (
    <pre className="overflow-auto">{plain}</pre>
  );
};

export default JsonRenderer;
