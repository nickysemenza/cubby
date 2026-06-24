import { JsonEditor } from "json-edit-react";
import { Code, RotateCcw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { cn } from "~/lib/utils";

interface EditableComponentDemoProps<T> {
  title: string;
  description?: string;
  schema: z.ZodType<T>;
  defaultData: T;
  children: (data: T) => React.ReactNode;
  className?: string;
}

/**
 * Wrapper component for interactive demos with editable JSON data.
 * Shows the component with current data and an optional JSON editor panel.
 */
export function EditableComponentDemo<T>({
  title,
  description,
  schema,
  defaultData,
  children,
  className,
}: EditableComponentDemoProps<T>) {
  const [data, setData] = useState<T>(defaultData);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Convert Zod schema to JSON Schema for validation hints
  const jsonSchema = useMemo(() => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      return zodToJsonSchema(schema as any, { target: "jsonSchema7" });
    } catch {
      return undefined;
    }
  }, [schema]);

  const handleUpdate = useCallback(
    (newData: unknown) => {
      // Validate with Zod before accepting
      const result = schema.safeParse(newData);
      if (result.success) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error.issues[0]?.message ?? "Invalid data");
      }
    },
    [schema],
  );

  const handleReset = useCallback(() => {
    setData(defaultData);
    setError(null);
  }, [defaultData]);

  return (
    <div className={cn("my-6", className)}>
      {/* Header */}
      <Row align="center" gap="sm" className="mb-2">
        <span className="inline-flex items-center rounded bg-secondary px-2 py-1 font-medium text-secondary-foreground text-xs">
          Interactive
        </span>
        {title && <span className="font-medium">{title}</span>}
        <Row gap="sm" className="ml-auto">
          {isEditing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="h-7 gap-1 px-2 text-xs"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEditing(!isEditing)}
            className="h-7 gap-1 px-2 text-xs"
          >
            <Code className="h-3 w-3" />
            {isEditing ? "Hide JSON" : "Edit JSON"}
          </Button>
        </Row>
      </Row>

      {description && <Description className="mb-2">{description}</Description>}

      {/* JSON Editor (collapsible) */}
      {isEditing && (
        <div className="mb-4 overflow-hidden rounded-lg border border-[var(--border-chunky)]">
          <div className="border-b bg-muted/50 px-4 py-2 font-medium text-xs">
            Sample Data (editable)
          </div>
          <div className="max-h-80 overflow-auto p-2">
            <JsonEditor
              data={data}
              setData={handleUpdate}
              rootFontSize={12}
              collapse={2}
              restrictEdit={false}
              restrictDelete={false}
              restrictAdd={false}
              restrictTypeSelection={false}
              {...(jsonSchema ? { jsonSchema } : {})}
            />
          </div>
          {error && (
            <div className="border-t bg-destructive/10 px-4 py-2 text-destructive text-xs">
              Validation error: {error}
            </div>
          )}
        </div>
      )}

      {/* Demo content */}
      <div className="overflow-hidden rounded-lg border border-[var(--border-chunky)] bg-card">
        <div className="p-6">{children(data)}</div>
      </div>
    </div>
  );
}
