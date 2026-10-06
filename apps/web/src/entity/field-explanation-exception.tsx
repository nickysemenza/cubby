import {
  dataCheck,
  dataExceptionReasonLabel,
  setDataExceptionInput,
} from "@cubby/schemas/data-quality";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { useId, useState } from "react";

import { dataQuality } from "~/integrations/tanstack-query/generated/catalog.gen";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { NativeSelect } from "~/ui/primitives/native-select";

type ExplainedCheck = NonNullable<
  FieldExplanationOutput["qualityBreakdown"]
>["checks"][number];

/**
 * Evidence-bound accept/clear for one explained check. The reason list comes
 * from the server per check, so a check that forbids exceptions has an empty
 * list and no action; operational Problems and aggregate rules never reach
 * here because they are not breakdown checks.
 */
export function ExceptionControls({
  entityId,
  check,
}: {
  entityId: string;
  check: ExplainedCheck;
}) {
  const fieldId = useId();
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState(check.exceptionReasons[0]?.reason);
  const [note, setNote] = useState("");
  const set = useActionMutation({
    mutationFn: dataQuality.setException.mutationOptions,
    success: "Exception recorded",
    onSuccess: () => setAccepting(false),
  });
  const clear = useActionMutation({
    mutationFn: dataQuality.clearException.mutationOptions,
    success: "Exception cleared",
  });
  // Only exceptions-enabled entities parse; any other record has no action.
  const parsedTarget = setDataExceptionInput.shape.entityId.safeParse(entityId);
  const parsedCheck = dataCheck.safeParse(check.check);
  if (!parsedTarget.success || !parsedCheck.success) return null;
  const target = parsedTarget.data;
  const checkId = parsedCheck.data;

  if (check.exception) {
    return (
      <div className="grid gap-2 text-xs text-muted-foreground">
        <span className="leading-5">
          {check.exception.state === "stale"
            ? "Evidence changed since this exception was recorded: "
            : "Recorded as "}
          {dataExceptionReasonLabel[check.exception.reason]} —{" "}
          {check.exception.note}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={clear.isPending}
          onClick={() => clear.mutate({ entityId: target, check: checkId })}
        >
          Clear exception
        </Button>
      </div>
    );
  }
  if (check.state !== "gap" || check.exceptionReasons.length === 0 || !reason) {
    return null;
  }
  if (!accepting) {
    return (
      <div>
        <Button size="xs" variant="outline" onClick={() => setAccepting(true)}>
          Accept as…
        </Button>
      </div>
    );
  }
  return (
    <form
      className="grid gap-2 border-t border-border pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        set.mutate({
          entityId: target,
          check: checkId,
          reason,
          // The server requires a note; default to the reason's own label.
          note: note.trim() || dataExceptionReasonLabel[reason],
        });
      }}
    >
      <div className="grid gap-1 text-xs">
        <label htmlFor={`${fieldId}-reason`}>Reason</label>
        <NativeSelect
          id={`${fieldId}-reason`}
          value={reason}
          onChange={(event) => {
            const next = check.exceptionReasons.find(
              (option) => option.reason === event.target.value,
            );
            if (next) setReason(next.reason);
          }}
        >
          {check.exceptionReasons.map((option) => (
            <option key={option.reason} value={option.reason}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1 text-xs">
        <label htmlFor={`${fieldId}-note`}>Note</label>
        <Input
          id={`${fieldId}-note`}
          value={note}
          placeholder="Optional"
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" type="submit" disabled={set.isPending}>
          Accept exception
        </Button>
        <Button
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => setAccepting(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
