import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { ReportChoice, ReportForm } from "@cubby/schemas/entity-report";
import {
  type ChoiceAnswer,
  type ChoiceAnswers,
  remainingChoices,
  remainingSentence,
} from "@cubby/schemas/report-choice";
import { type ReactNode, useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities } from "~/entity/entities";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { EntityPicker } from "~/ui/combobox/entity-picker";
import {
  isReferencePickerEntity,
  requireReferenceEntitySearch,
} from "~/ui/combobox/reference-entity-search";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { NativeSelect } from "~/ui/primitives/native-select";
import { StatusText } from "~/ui/primitives/status-text";
import { Textarea } from "~/ui/primitives/textarea";

/**
 * The answers to a records block's choices. The operation id is the commit's idempotency key: it
 * changes with every answer, because the server rejects a replayed id that carries other input.
 */
export function useChoiceAnswers() {
  const [answers, setAnswers] = useState<ChoiceAnswers>({});
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  return {
    answers,
    operationId,
    answer: (choiceId: string, next: ChoiceAnswer | undefined) => {
      setOperationId(crypto.randomUUID());
      setAnswers((previous) => ({ ...previous, [choiceId]: next }));
    },
  };
}
export type ChoiceAnswerState = ReturnType<typeof useChoiceAnswers>;

/** One server-worded decision: ranked suggestions, an option select, and what the option asks for. */
export function ChoiceControl({
  choice,
  answer,
  disabled,
  onAnswer,
}: {
  choice: ReportChoice;
  answer: ChoiceAnswer | undefined;
  disabled: boolean;
  onAnswer: (next: ChoiceAnswer | undefined) => void;
}) {
  const option = choice.options.find((entry) => entry.id === answer?.optionId);
  // The picker shows a name; an answer made from a suggestion carries only the code.
  const [picked, setPicked] = useState<ComboboxItem | null>(null);
  const pickEntity = option?.pick?.entity;
  const picker = useMemo(
    () =>
      pickEntity !== undefined && isReferencePickerEntity(pickEntity)
        ? {
            entity: pickEntity,
            Search: requireReferenceEntitySearch(pickEntity),
          }
        : null,
    [pickEntity],
  );
  const choosePick = (item: ComboboxItem | null, optionId: string) => {
    setPicked(item);
    onAnswer(item ? { optionId, pickId: item.id } : undefined);
  };
  return (
    <Stack gap="sm">
      {(choice.suggestions ?? []).map((suggestion) => (
        <Row wrap gap="sm" key={`${suggestion.optionId}:${suggestion.id}`}>
          <SuggestionLink suggestion={suggestion} />
          {suggestion.badges.map((badge) => (
            <Badge key={badge} variant="outline">
              {badge}
            </Badge>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              choosePick(
                { id: suggestion.id, name: suggestion.name },
                suggestion.optionId,
              )
            }
          >
            {suggestion.label}
          </Button>
        </Row>
      ))}
      <label className="flex flex-col gap-1 text-xs">
        <span>{choice.label}</span>
        <NativeSelect
          aria-label={choice.label}
          value={answer?.optionId ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const next = choice.options.find(
              (entry) => entry.id === event.target.value,
            );
            if (!next) return onAnswer(undefined);
            // A pick or reason already given survives while the new option still asks for it.
            const kept: ChoiceAnswer = { optionId: next.id };
            if (next.pick && answer?.pickId) kept.pickId = answer.pickId;
            if (next.text && answer?.text) kept.text = answer.text;
            onAnswer(kept);
          }}
        >
          <option value="">Choose…</option>
          {choice.options.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </NativeSelect>
      </label>
      {option?.pick && picker ? (
        <picker.Search>
          {({ items, onSearchChange, onOpenChange, isLoading }) => (
            <EntityPicker
              entity={picker.entity}
              label={option.pick?.label ?? choice.label}
              items={items}
              value={
                answer?.pickId
                  ? (picked ?? { id: answer.pickId, name: answer.pickId })
                  : null
              }
              setValue={(item) => choosePick(item, option.id)}
              onSearchChange={onSearchChange}
              onOpenChange={onOpenChange}
              isLoading={isLoading}
              disabled={disabled}
            />
          )}
        </picker.Search>
      ) : null}
      {option?.hint ? <StatusText>{option.hint}</StatusText> : null}
      {option?.text ? (
        <label className="flex flex-col gap-1 text-xs">
          <span>{option.text.label}</span>
          <Textarea
            aria-label={option.text.label}
            value={answer?.text ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onAnswer({ optionId: option.id, text: event.target.value })
            }
          />
        </label>
      ) : null}
    </Stack>
  );
}

function SuggestionLink({
  suggestion,
}: {
  suggestion: NonNullable<ReportChoice["suggestions"]>[number];
}): ReactNode {
  // SAFETY: `entities` is keyed by exactly the browser-routed entities.
  const routed = Object.hasOwn(entities, suggestion.entity)
    ? (suggestion.entity as BrowserRoutedEntity)
    : null;
  return (
    <>
      {routed ? (
        <EntityRefLink
          variant="chip"
          entity={routed}
          id={suggestion.id}
          name={suggestion.name}
          displayImage={null}
        />
      ) : (
        <span className="text-sm">{suggestion.name}</span>
      )}
      {suggestion.subtitle ? (
        <span className="text-xs text-muted-foreground">
          {suggestion.subtitle}
        </span>
      ) : null}
    </>
  );
}

/**
 * A block's own choices and its one command: the remaining count, what approving does, and the
 * button, only after the server says it can run. The enabled rule is the shared one: every
 * required choice, the block's and its rows', has a complete answer.
 */
export function ChoiceFormFooter({
  form,
  rowChoices,
  state,
  pending,
  done,
  onRun,
}: {
  form: ReportForm;
  rowChoices: readonly ReportChoice[];
  state: ChoiceAnswerState;
  pending: boolean;
  done: boolean;
  onRun: () => void;
}) {
  if (done) return <StatusText>Submitted.</StatusText>;
  if (form.disabledReason !== null)
    return <StatusText>{form.disabledReason}</StatusText>;
  const remaining = remainingChoices(rowChoices, state.answers);
  const unanswered = remaining + remainingChoices(form.choices, state.answers);
  return (
    <Stack gap="sm">
      {form.choices.map((choice) => (
        <ChoiceControl
          key={choice.id}
          choice={choice}
          answer={state.answers[choice.id]}
          disabled={pending}
          onAnswer={(next) => state.answer(choice.id, next)}
        />
      ))}
      <StatusText>
        {remaining
          ? remainingSentence(form.noun, remaining)
          : form.completeText}{" "}
        {form.note}
      </StatusText>
      <Button
        type="button"
        disabled={pending || unanswered > 0}
        onClick={onRun}
      >
        {pending ? "Importing…" : form.command.label}
      </Button>
    </Stack>
  );
}
