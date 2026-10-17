import { executionAuthorizationApprovalInput } from "@cubby/schemas/execution-authorization";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { buildVendorComboboxItem } from "~/entity/picker/combobox-builders";
import { Picker } from "~/entity/picker/picker";
import { run } from "~/integrations/tanstack-query/generated/catalog.gen";
import { householdLocalDate, shiftPlainDate } from "~/lib/household-date";
import { DatePickerInput } from "~/ui/date-picker-input";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/ui/primitives/card";
import { Input } from "~/ui/primitives/input";
import { StatusText } from "~/ui/primitives/status-text";

/** One explicit allowance, then durable prerequisite waits and automatic work. */
export function VendorHistoryApproval() {
  const mailboxes = useQuery(run.executionMailboxes.queryOptions({}));
  const vendors = useQuery(run.merchantRules.queryOptions());
  const items = useMemo(
    () =>
      (vendors.data?.vendors ?? []).map((vendor) =>
        buildVendorComboboxItem(
          {
            id: parseShortcodeFor("vendor", vendor.shortcode),
            name: vendor.name,
          },
          { itemId: "shortcode" },
        ),
      ),
    [vendors.data],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [mailboxId, setMailboxId] = useState("");
  const [after, setAfter] = useState<string | null>(null);
  const [before, setBefore] = useState<string | null>(() =>
    shiftPlainDate(householdLocalDate(new Date()), 1),
  );
  const [candidates, setCandidates] = useState("100");
  const [products, setProducts] = useState("0");
  const [budget, setBudget] = useState("");
  const [days, setDays] = useState("7");
  const approval = useMutation({
    mutationFn: async () => {
      const input = executionAuthorizationApprovalInput.parse({
        scope: {
          kind: "vendor_backfill",
          mailboxId,
          discovery: "vendor_history",
          vendors: selected.map((vendorId) => ({ vendorId })),
          senderPolicy: "verified_at_first_start",
          receivedAfter: after,
          receivedBefore: before,
          candidateLimit: Number(candidates),
          productLimit: Number(products),
        },
        meteredBudget: {
          period: "lifetime",
          limitMicroUSD: Math.round(Number(budget) * 1_000_000),
        },
        expiresAt: new Date(
          Date.now() + Number(days) * 86_400_000,
        ).toISOString(),
      });
      return run.approveExecution.call(input);
    },
  });
  const pending = mailboxes.isLoading || vendors.isLoading;
  const connectedMailboxes = mailboxes.data?.mailboxes ?? [];
  const readError = mailboxes.error ?? vendors.error;
  return (
    <Card className="max-md:border-x-0">
      <CardHeader>
        <CardTitle>Vendor email history</CardTitle>
        <CardDescription>
          Search selected Vendors within a fixed date range and allowance.
          Missing website or sender evidence waits for research in the Work
          queue. Sender and website-domain searches freeze when each Vendor
          starts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Stack gap="md">
          {pending ? (
            <StatusText>Loading connected mailboxes and Vendors…</StatusText>
          ) : null}
          {readError ? <ErrorDisplay error={readError} /> : null}
          {!pending && !readError ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                approval.mutate();
              }}
            >
              <div className="grid gap-1">
                <span className="text-sm">Mailbox</span>
                <Picker
                  mode="choose"
                  label="Mailbox"
                  placeholder={
                    connectedMailboxes.length
                      ? "Choose a mailbox…"
                      : "No connected Gmail mailbox"
                  }
                  disabled={connectedMailboxes.length === 0}
                  options={connectedMailboxes.map((mailbox) => ({
                    value: mailbox.mailboxId,
                    label: mailbox.mailboxId,
                  }))}
                  value={mailboxId || null}
                  onValueChange={(value) => setMailboxId(value ?? "")}
                />
                {connectedMailboxes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Connect Google &amp; Gmail above to choose a mailbox.
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1">
                <span className="text-sm">Vendors</span>
                <Picker
                  multiple
                  entity="vendor"
                  label="Vendors"
                  items={items}
                  values={items.filter((item) => selected.includes(item.id))}
                  setValues={(values) =>
                    setSelected(values.map((value) => value.id))
                  }
                />
                <p className="text-sm text-muted-foreground">
                  Choose up to 20 Vendors per approval.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label htmlFor="history-after" className="grid gap-1 text-sm">
                  Received after (optional)
                  <DatePickerInput
                    id="history-after"
                    value={after}
                    onChange={setAfter}
                    clearable
                  />
                </label>
                <label htmlFor="history-before" className="grid gap-1 text-sm">
                  Received before
                  <DatePickerInput
                    id="history-before"
                    value={before}
                    onChange={setBefore}
                    required
                  />
                </label>
                <label
                  htmlFor="history-candidates"
                  className="grid gap-1 text-sm"
                >
                  Maximum candidate emails
                  <Input
                    id="history-candidates"
                    type="number"
                    min="1"
                    required
                    value={candidates}
                    onChange={(event) => setCandidates(event.target.value)}
                  />
                </label>
                <label
                  htmlFor="history-products"
                  className="grid gap-1 text-sm"
                >
                  Maximum new Products
                  <Input
                    id="history-products"
                    type="number"
                    min="0"
                    required
                    value={products}
                    onChange={(event) => setProducts(event.target.value)}
                  />
                </label>
                <label htmlFor="history-budget" className="grid gap-1 text-sm">
                  Maximum model spend (USD)
                  <Input
                    id="history-budget"
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                  />
                </label>
                <label htmlFor="history-days" className="grid gap-1 text-sm">
                  Approval expires after days
                  <Input
                    id="history-days"
                    type="number"
                    min="1"
                    max="365"
                    required
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                  />
                </label>
              </div>
              <p className="text-sm text-muted-foreground">
                This allows classification and supported source-proven imports,
                including Purchase and Expense changes. Ambiguous ownership or
                matching waits for review. It does not receive inventory.
              </p>
              <Button
                type="submit"
                disabled={
                  approval.isPending ||
                  !mailboxId ||
                  selected.length === 0 ||
                  selected.length > 20
                }
              >
                Approve Vendor history
              </Button>
            </form>
          ) : null}
          {approval.isError ? <ErrorDisplay error={approval.error} /> : null}
          {approval.isSuccess ? (
            <p className="text-sm">
              Approval saved.{" "}
              <Link to="/work-queue" className="underline">
                View progress and prerequisites
              </Link>
            </p>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
