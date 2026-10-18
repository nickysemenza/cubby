import {
  AUTOMATIC_RULE_MIN_PRECISION,
  AUTOMATIC_RULE_MIN_REVIEWS,
  automaticRuleKey,
  type AutomaticRuleKey,
  type AutomaticRuleOut,
} from "@cubby/schemas/automatic-rule";
import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { getErrorMessage } from "@cubby/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { suggestions } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCount } from "~/lib/number-format";
import { DateDisplay } from "~/ui/common/date-display";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { Section } from "~/ui/layout/section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/primitives/alert-dialog";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Switch } from "~/ui/primitives/switch";

import { automaticMissItem } from "./suggestion-review";
import { useSuggestionReview } from "./suggestion-review-context";
import { RecordLink } from "./suggestion-values";

const RULE_NAME = {
  "field.addition": "Field Addition",
  "statement_transaction.attach": "Statement attach",
} satisfies Record<AutomaticRuleKey, string>;

/** `<ruleKey>@<revision>[@<model>]` as its rule and revision, or null when unknown. */
function parseRuleStamp(stamp: string) {
  const [key, revision, model] = stamp.split("@");
  const ruleKey = automaticRuleKey.safeParse(key).data;
  return ruleKey && revision
    ? { ruleKey, name: RULE_NAME[ruleKey], revision, model: model ?? null }
    : null;
}

/** Floored to a tenth so a rule just under the bar never reads as at it. */
const formatPrecision = (precision: number) =>
  `${Math.floor(Math.round(precision * 1e6) / 1e3) / 10}%`;

/** The measured numbers, e.g. "98.6% precision over 140 reviewed · 2 corrected automatic". */
function ruleNumbers(
  rule: Pick<AutomaticRuleOut, "n" | "precision" | "correctedAutomatic">,
) {
  const measured =
    rule.n && rule.precision !== null
      ? `${formatPrecision(rule.precision)} precision over ${formatCount(rule.n)} reviewed`
      : "No reviewed matches yet";
  return rule.correctedAutomatic
    ? `${measured} · ${formatCount(rule.correctedAutomatic)} corrected automatic`
    : measured;
}

const BAR = `${formatPrecision(AUTOMATIC_RULE_MIN_PRECISION)} over at least ${AUTOMATIC_RULE_MIN_REVIEWS} reviewed`;

export type AutomaticRuleOperations = {
  rules: typeof suggestions.rules;
  setRule: typeof suggestions.setRule;
};
const CATALOG_OPERATIONS: AutomaticRuleOperations = {
  rules: suggestions.rules,
  setRule: suggestions.setRule,
};

/**
 * Each Automatic rule with its measured precision and the member's switch.
 * On is offered only when eligible; the server still decides, and its refusal
 * shows raw. Off is always allowed, after a confirm.
 */
export function AutomaticRulesSection({
  operations = CATALOG_OPERATIONS,
  defaultOpen = false,
}: {
  operations?: AutomaticRuleOperations;
  defaultOpen?: boolean;
}) {
  const rules = useQuery(operations.rules.queryOptions({}));
  const list = rules.data?.rules ?? [];
  const on = list.filter((rule) => rule.enabled).length;
  return (
    <Section
      title="Automatic rules"
      headingAs="h2"
      meta={rules.data ? `${on} of ${list.length} on` : null}
      disclosure={{ defaultOpen }}
    >
      {rules.error ? (
        <p
          role="alert"
          className="font-mono whitespace-pre-wrap text-destructive"
        >
          {getErrorMessage(rules.error)}
        </p>
      ) : rules.isLoading ? (
        <p className="text-muted-foreground">Loading rules…</p>
      ) : (
        <Ledger aria-label="Automatic rules">
          {list.map((rule) => (
            <RuleRow key={rule.ruleKey} rule={rule} operations={operations} />
          ))}
        </Ledger>
      )}
    </Section>
  );
}

function RuleRow({
  rule,
  operations,
}: {
  rule: AutomaticRuleOut;
  operations: AutomaticRuleOperations;
}) {
  const name = RULE_NAME[rule.ruleKey];
  const [confirmingOff, setConfirmingOff] = useState(false);
  const set = useMutation(operations.setRule.mutationOptions());
  const change = (enabled: boolean) =>
    set.mutate({ ruleKey: rule.ruleKey, enabled });
  return (
    <LedgerRow aria-label={name}>
      <LedgerCell
        slot="primary"
        className="flex flex-wrap items-baseline gap-x-2"
      >
        <span className="font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">
          revision {rule.revision}
        </span>
      </LedgerCell>
      <LedgerCell
        slot="trailing"
        className="flex items-center justify-end gap-2"
      >
        {rule.enabled ? (
          <Badge variant="positive">On</Badge>
        ) : (
          <Badge variant="outline">Off</Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {rule.eligible ? "Eligible" : "Not yet eligible"}
        </span>
        <Switch
          aria-label={`${name} automatic rule`}
          checked={rule.enabled}
          // On is offered only when eligible; off is always allowed.
          disabled={set.isPending || (!rule.enabled && !rule.eligible)}
          onCheckedChange={(checked) =>
            checked ? change(true) : setConfirmingOff(true)
          }
          className="max-md:my-3"
        />
      </LedgerCell>
      <LedgerCell slot="secondary" className="flex flex-col gap-0.5 text-xs">
        <span>{rule.description}</span>
        <span className="text-muted-foreground tabular-nums">
          {ruleNumbers(rule)}
          {rule.eligible ? null : ` · eligible at ${BAR}`}
        </span>
        {rule.enabled && rule.enabledAt ? (
          <span className="text-muted-foreground">
            On since <DateDisplay timestamp={rule.enabledAt} />
            {rule.enabledByUserId ? null : " · by a migration"}
            {rule.enabledReason ? ` · ${rule.enabledReason}` : null}
          </span>
        ) : null}
        {!rule.enabled && rule.disabledReason ? (
          <span className="font-mono whitespace-pre-wrap text-muted-foreground">
            {rule.disabledReason}
          </span>
        ) : null}
        {set.error ? (
          <span
            role="alert"
            className="font-mono whitespace-pre-wrap text-destructive"
          >
            {getErrorMessage(set.error)}
          </span>
        ) : null}
      </LedgerCell>
      <AlertDialog open={confirmingOff} onOpenChange={setConfirmingOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its matches wait for review again. Changes it already applied
              stay. Turning it back on needs it to be eligible ({BAR}).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmingOff(false);
                change(false);
              }}
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </LedgerRow>
  );
}

/** The rule that applied a row, with its revision and current measured precision. */
export function AuthorizedBy({ row }: { row: SuggestionListRow }) {
  const rules = useQuery(suggestions.rules.queryOptions({}));
  const stamp = row.automaticRule ? parseRuleStamp(row.automaticRule) : null;
  if (!stamp)
    return (
      <span className="font-mono text-xs">
        {row.automaticRule ?? "Unknown"}
      </span>
    );
  const rule = rules.data?.rules.find((item) => item.ruleKey === stamp.ruleKey);
  // Precision is measured per revision; an earlier one's is not today's.
  const current = rule?.revision === stamp.revision ? rule : null;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="inline-flex items-center gap-1.5">
        <Badge variant="slate">Automatic</Badge>
        <span className="truncate">{stamp.name}</span>
      </span>
      <span className="truncate text-2xs text-muted-foreground tabular-nums">
        revision {stamp.revision}
        {current?.precision != null
          ? ` · ${formatPrecision(current.precision)} precision now`
          : rule && !current
            ? " · an earlier revision"
            : null}
      </span>
    </span>
  );
}

/**
 * Wrong on an automatic change records a Miss against its rule through the
 * normal review path. It is not an undo: the change stays, corrected on its record.
 */
export function AutomaticWrongCell({ row }: { row: SuggestionListRow }) {
  const { review, outcome } = useSuggestionReview();
  const [confirming, setConfirming] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const state = outcome(row.id);
  const name = row.automaticRule
    ? (parseRuleStamp(row.automaticRule)?.name ?? row.automaticRule)
    : "its rule";
  return (
    <div className="flex min-w-0 items-center justify-end gap-1">
      {state?.state === "failed" ? (
        <span
          role="alert"
          className="min-w-0 truncate text-xs text-destructive"
          title={state.error}
        >
          {state.error}
        </span>
      ) : recorded ? (
        <span className="text-xs text-muted-foreground">Miss recorded</span>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={state?.state === "pending"}
        onClick={(event) => {
          event.stopPropagation();
          setConfirming(true);
        }}
      >
        Wrong…
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Record a Miss against {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This records a Miss, counted as a corrected automatic application
              of the rule. Automatic applications sit outside its precision
              window, so precision does not move. There is no undo: the change
              itself stays; correct it on{" "}
              <RecordLink record={row.other ?? row.record} />.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                void review([row], automaticMissItem).then((failures) =>
                  setRecorded(failures.length === 0),
                );
              }}
            >
              Record Miss
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
