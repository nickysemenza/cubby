import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CodeIcon as Code } from "@phosphor-icons/react/dist/csr/Code";
import { JsonEditor, type JsonData } from "json-edit-react";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";

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
      return z.toJSONSchema(schema, {
        target: "draft-07",
        unrepresentable: "any",
      });
    } catch {
      return undefined;
    }
  }, [schema]);
  // Runtime prop accepted by json-edit-react but absent from its published props.
  type JsonEditorSchemaProps = { jsonSchema?: typeof jsonSchema };

  const handleUpdate = useCallback(
    (newData: JsonData) => {
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

  const jsonEditorSchemaProps: JsonEditorSchemaProps = {};
  if (jsonSchema) jsonEditorSchemaProps.jsonSchema = jsonSchema;

  return (
    <div className={cn("my-6", className)}>
      {/* Header */}
      <Row align="center" gap="sm" className="mb-2">
        <span className="inline-flex items-center rounded bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground">
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
              <RotateCcw className="size-3" />
              Reset
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEditing(!isEditing)}
            className="h-7 gap-1 px-2 text-xs"
          >
            <Code className="size-3" />
            {isEditing ? "Hide JSON" : "Edit JSON"}
          </Button>
        </Row>
      </Row>

      {description && <Description className="mb-2">{description}</Description>}

      {/* JSON Editor (collapsible) */}
      {isEditing && (
        <div className="mb-4 overflow-hidden border border-[var(--border)]">
          <div className="border-b bg-muted/50 px-4 py-2 text-xs font-medium">
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
              {...jsonEditorSchemaProps}
            />
          </div>
          {error && (
            <div className="border-t bg-destructive/10 px-4 py-2 text-xs text-destructive">
              Validation error: {error}
            </div>
          )}
        </div>
      )}

      {/* Demo content */}
      <div className="overflow-hidden border border-[var(--border)] bg-card">
        <div className="p-6">{children(data)}</div>
      </div>
    </div>
  );
}
