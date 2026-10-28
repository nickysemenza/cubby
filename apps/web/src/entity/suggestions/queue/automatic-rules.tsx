import type {
  AutomaticRuleKey,
  AutomaticRuleOut,
} from "@cubby/schemas/automatic-rule";
import { getErrorMessage } from "@cubby/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { suggestions } from "~/integrations/tanstack-query/domains/suggestions";
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
import { Switch } from "~/ui/primitives/switch";

const RULE_NAME = {
  "field.addition": "Field assignment",
  "statement_transaction.attach": "Statement attach",
  "statement_transaction.book_spending": "Statement spending",
} satisfies Record<AutomaticRuleKey, string>;

export type AutomaticRuleOperations = {
  rules: typeof suggestions.rules;
  setRule: typeof suggestions.setRule;
};
const CATALOG_OPERATIONS: AutomaticRuleOperations = {
  rules: suggestions.rules,
  setRule: suggestions.setRule,
};

/**
 * Each Automatic rule and the member's switch. The server still decides, and
 * its refusal shows raw. Off asks for a confirm.
 */
export function AutomaticRulesSection({
  operations = CATALOG_OPERATIONS,
}: {
  operations?: AutomaticRuleOperations;
}) {
  const rules = useQuery(operations.rules.queryOptions({}));
  const list = rules.data?.rules ?? [];
  const on = list.filter((rule) => rule.enabled).length;
  return (
    <Section
      title="Automatic rules"
      headingAs="h2"
      caption={rules.data ? `${on} of ${list.length} on` : null}
    >
      <p className="mb-2 text-sm text-muted-foreground">
        These switches control statement automation. Eligible empty-field
        filling follows its fixed policy; saved values and rejections remain
        protected.
      </p>
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
  const importPolicy = rule.ruleKey === "statement_transaction.book_spending";
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
        <Switch
          aria-label={`${name} automatic rule`}
          checked={rule.enabled}
          disabled={set.isPending}
          onCheckedChange={(checked) =>
            checked ? change(true) : setConfirmingOff(true)
          }
          className="max-md:my-3"
        />
      </LedgerCell>
      <LedgerCell slot="secondary" className="flex flex-col gap-0.5 text-xs">
        <span>{rule.description}</span>
        {importPolicy ? (
          <span className="text-muted-foreground">
            Clean import policy · on by default
          </span>
        ) : null}
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
              Future matches wait for review. Changes it already applied stay.
              {importPolicy
                ? " You can resume this policy at any time; resuming does not immediately apply the backlog."
                : " You can turn it back on at any time."}
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
