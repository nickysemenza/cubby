import type { ReactNode } from "react";
import { useId } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

export function GardenField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "date";
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Stack gap="sm">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
      />
    </Stack>
  );
}

export function GardenNotes({
  value,
  onChange,
  label = "Notes",
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Stack gap="sm">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Stack>
  );
}

export function GardenFormActions({
  pending,
  error,
  onCancel,
  label = "Save",
  children,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <Stack gap="md">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {children}
      <Row gap="sm" justify="end">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : label}
        </Button>
      </Row>
    </Stack>
  );
}
