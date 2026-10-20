import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { ReportChoice, ReportForm } from "@cubby/schemas/entity-report";
import {
  type ChoiceAnswer,
  type ChoiceAnswers,
  commitPreparedInput,
  distinctFromForOption,
  distinctFromSourceFeedback,
  remainingChoices,
  remainingSentence,
} from "@cubby/schemas/report-choice";
import { type ReactNode, useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities } from "~/entity/entities";
import { Picker } from "~/entity/picker/picker";
import { requireReferenceEntitySearch } from "~/entity/picker/reference-entity-search";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { isReferencePickerEntity } from "~/ui/combobox/reference-picker-entities";
import { Row, Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
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
  const choiceOptions = useMemo<PickerOption[]>(
    () =>
      choice.options.map((entry) => ({ value: entry.id, label: entry.label })),
    [choice.options],
  );
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
          <ChoiceRecordLink record={suggestion} />
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
      <div className="flex flex-col gap-1 text-xs">
        <span>{choice.label}</span>
        <Picker
          mode="choose"
          clearable
          label={choice.label}
          placeholder="Choose…"
          options={choiceOptions}
          value={answer?.optionId ?? null}
          disabled={disabled}
          onValueChange={(value) => {
            const next = choice.options.find((entry) => entry.id === value);
            if (!next) return onAnswer(undefined);
            // A pick or reason already given survives while the new option still asks for it.
            const kept: ChoiceAnswer = { optionId: next.id };
            if (next.pick && answer?.pickId) kept.pickId = answer.pickId;
            if (next.text && answer?.text) kept.text = answer.text;
            if (next.distinctFrom && answer?.distinctFrom)
              kept.distinctFrom = distinctFromForOption(
                next,
                answer.distinctFrom,
              );
            onAnswer(kept);
          }}
        />
      </div>
      {option?.pick && picker ? (
        <picker.Search>
          {({ items, onSearchChange, onOpenChange, isLoading }) => (
            <Picker
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
      {option?.distinctFrom?.map((record) => {
        const source = answer?.distinctFrom?.[record.id] ?? {
          url: "",
          quote: "",
        };
        const setSource = (next: typeof source) =>
          onAnswer({
            optionId: option.id,
            distinctFrom: distinctFromForOption(option, {
              ...answer?.distinctFrom,
              [record.id]: next,
            }),
          });
        const errors = distinctFromSourceFeedback(source);
        const fieldId = `${choice.id}:${record.id}`;
        return (
          <Stack gap="sm" key={record.id}>
            <Row wrap gap="sm">
              <StatusText>Show with a Source how this differs from</StatusText>
              <ChoiceRecordLink record={record} />
            </Row>
            <label className="flex flex-col gap-1 text-xs">
              <span>Source URL for {record.name}</span>
              <Input
                type="url"
                inputMode="url"
                autoComplete="url"
                aria-label={`Source URL for ${record.name}`}
                aria-invalid={errors.url ? true : undefined}
                aria-describedby={errors.url ? `${fieldId}:url` : undefined}
                value={source.url}
                disabled={disabled}
                onChange={(event) =>
                  setSource({ ...source, url: event.target.value })
                }
              />
              {errors.url ? (
                <StatusText id={`${fieldId}:url`} tone="destructive">
                  {errors.url}
                </StatusText>
              ) : null}
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span>Quoted difference from {record.name}</span>
              <Textarea
                aria-label={`Quoted difference from ${record.name}`}
                aria-invalid={errors.quote ? true : undefined}
                aria-describedby={`${fieldId}:quote`}
                value={source.quote}
                disabled={disabled}
                onChange={(event) =>
                  setSource({ ...source, quote: event.target.value })
                }
              />
              <StatusText
                id={`${fieldId}:quote`}
                tone={errors.quote ? "destructive" : "muted"}
              >
                {errors.quote ?? errors.quoteLength}
              </StatusText>
            </label>
          </Stack>
        );
      })}
    </Stack>
  );
}

/** A ranked suggestion or a Distinct-from record, linked when its entity has a page. */
function ChoiceRecordLink({
  record,
}: {
  record: Pick<
    NonNullable<ReportChoice["suggestions"]>[number],
    "entity" | "id" | "name" | "subtitle"
  >;
}): ReactNode {
  // SAFETY: `entities` is keyed by exactly the browser-routed entities.
  const routed = Object.hasOwn(entities, record.entity)
    ? (record.entity as BrowserRoutedEntity)
    : null;
  return (
    <>
      {routed ? (
        <EntityRefLink
          variant="chip"
          entity={routed}
          id={record.id}
          name={record.name}
          displayImage={null}
        />
      ) : (
        <span className="text-sm">{record.name}</span>
      )}
      {record.subtitle ? (
        <span className="text-xs text-muted-foreground">{record.subtitle}</span>
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
  const [confirmedOperation, setConfirmedOperation] = useState<string | null>(
    null,
  );
  if (done) return <StatusText>{form.doneText}</StatusText>;
  if (form.disabledReason !== null)
    return <StatusText>{form.disabledReason}</StatusText>;
  const remaining = remainingChoices(rowChoices, state.answers);
  const unanswered = remaining + remainingChoices(form.choices, state.answers);
  // The same parse the click uses: a complete-looking answer that cannot become a body (an
  // over-long reason) must say so rather than do nothing.
  const buildable =
    commitPreparedInput(
      form.command.request,
      state.answers,
      state.operationId,
    ) !== null;
  return (
    <Stack gap="sm">
      <Overlay
        open={confirmedOperation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmedOperation(null);
        }}
        title={form.command.label}
        description={form.command.confirm}
        pending={pending}
        primary={{
          label: form.command.label,
          disabled:
            unanswered > 0 ||
            !buildable ||
            confirmedOperation !== state.operationId,
          onClick: () => {
            if (
              confirmedOperation === state.operationId &&
              unanswered === 0 &&
              buildable
            ) {
              onRun();
              setConfirmedOperation(null);
            }
          },
        }}
      />
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
      {unanswered === 0 && !buildable ? (
        <StatusText tone="destructive">
          An answer cannot be sent: a reason is at most 1,000 characters, a
          Product must be chosen from the picker, and a Source needs a full URL.
        </StatusText>
      ) : null}
      <Button
        type="button"
        disabled={pending || unanswered > 0 || !buildable}
        onClick={() => {
          if (form.command.confirm) setConfirmedOperation(state.operationId);
          else onRun();
        }}
      >
        {pending ? "Importing…" : form.command.label}
      </Button>
    </Stack>
  );
}
