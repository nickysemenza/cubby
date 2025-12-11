"use client";

import { useState, useMemo, useCallback } from "react";
import { JsonEditor } from "json-edit-react";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Code, RotateCcw } from "lucide-react";

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    <div className={cn("my-8", className)}>
      {/* Header */}
      <div className="mb-3 flex items-center gap-3">
        <span className="inline-flex items-center rounded bg-green-100 px-2 py-1 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
          Interactive
        </span>
        {title && <span className="font-medium">{title}</span>}
        <div className="ml-auto flex gap-2">
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
        </div>
      </div>

      {description && (
        <p className="text-muted-foreground mb-3 text-sm">{description}</p>
      )}

      {/* JSON Editor (collapsible) */}
      {isEditing && (
        <div className="mb-4 overflow-hidden rounded-lg border">
          <div className="bg-muted/50 border-b px-3 py-2 text-xs font-medium">
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
            <div className="border-t bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/30 dark:text-red-400">
              Validation error: {error}
            </div>
          )}
        </div>
      )}

      {/* Demo content */}
      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="p-6">{children(data)}</div>
      </div>
    </div>
  );
}
