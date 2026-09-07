import type {
  CalendarCredential,
  CalendarRotateCredential,
} from "@cubby/schemas/calendar";
import { useQuery } from "@tanstack/react-query";
import { CalendarSync, Copy, KeyRound } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { calendar } from "~/app/calendar/calendar.functions";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { StatusText } from "~/components/ui/status-text";
import { copyText } from "~/lib/clipboard";

const caldavUrl = (origin: string) => `${origin}/api/caldav/`;

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void copyText(value).then((copied) =>
          copied
            ? toast.success(`${label} copied`)
            : toast.error("Copy failed"),
        );
      }}
    >
      <Copy className="size-3" aria-hidden />
      Copy
    </Button>
  );
}

function CredentialValue({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  return (
    <Stack gap="xs" className="rounded border border-border px-4 py-3">
      <Row align="center" justify="between" gap="sm">
        <span className="text-sm font-medium">{label}</span>
        <CopyButton value={value} label={label} />
      </Row>
      <code
        className={`font-mono text-xs break-all ${
          secret ? "text-foreground select-all" : "text-muted-foreground"
        }`}
      >
        {value}
      </code>
    </Stack>
  );
}

export function CalendarCalDavSetupContent({
  credential,
  issued,
  isRotating,
  isRevoking,
  onRotate,
  onRevoke,
}: {
  credential: CalendarCredential | undefined;
  issued: CalendarRotateCredential | null;
  isRotating: boolean;
  isRevoking: boolean;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const username = issued?.username ?? credential?.username ?? "";
  const origin = globalThis.window?.location.origin ?? "";

  if (issued) {
    return (
      <Stack gap="md">
        <StatusText tone="warning">
          Copy this password now. Cubby stores only its hash and cannot show it
          again.
        </StatusText>
        <CredentialValue label="Server" value={caldavUrl(origin)} />
        <CredentialValue label="Username" value={issued.username} />
        <CredentialValue label="App password" value={issued.password} secret />
        <SetupNotes />
        <Row justify="end">
          <Button variant="outline" onClick={onRotate} disabled={isRotating}>
            {isRotating ? "Generating…" : "Replace password"}
          </Button>
        </Row>
      </Stack>
    );
  }

  if (!credential) return <StatusText>Loading Calendar access…</StatusText>;

  return (
    <Stack gap="md">
      {credential.configured ? (
        <>
          <StatusText>
            A Calendar app password is active. Generate a replacement if you
            need to add another device; the old password will stop working.
          </StatusText>
          <CredentialValue label="Server" value={caldavUrl(origin)} />
          <CredentialValue label="Username" value={username} />
          <SetupNotes />
          <Row justify="end" gap="sm" wrap>
            <Button variant="outline" disabled={isRevoking} onClick={onRevoke}>
              {isRevoking ? "Revoking…" : "Revoke access"}
            </Button>
            <Button disabled={isRotating} onClick={onRotate}>
              {isRotating ? "Generating…" : "Replace password"}
            </Button>
          </Row>
        </>
      ) : (
        <>
          <StatusText>
            Create a separate app password to add Cubby as a CalDAV account in
            Calendar. It is distinct from read-only subscription URLs.
          </StatusText>
          <SetupNotes />
          <Row justify="end">
            <Button disabled={isRotating} onClick={onRotate}>
              <KeyRound className="size-3" aria-hidden />
              {isRotating ? "Generating…" : "Create app password"}
            </Button>
          </Row>
        </>
      )}
    </Stack>
  );
}

function SetupNotes() {
  return (
    <Stack
      gap="xs"
      className="rounded border border-border bg-muted/25 px-4 py-3"
    >
      <span className="text-sm font-medium">Calendar.app setup</span>
      <p className="text-xs text-muted-foreground">
        On macOS, open Calendar → Settings → Accounts → + → Other CalDAV
        Account, choose Manual, then enter the server, username, and app
        password. Cubby exposes editable Tasks, Completed Tasks, and Meals
        calendars.
      </p>
      <p className="text-xs text-muted-foreground">
        Meal times snap to Cubby meal slots; notes, locations, and alerts are
        not saved. The Everything subscription remains read-only.
      </p>
    </Stack>
  );
}

export function CalendarCalDavSetupDialog() {
  const [queryEnabled, setQueryEnabled] = useState(false);
  const credential = useQuery({
    ...calendar.getCredential.queryOptions(),
    enabled: queryEnabled,
  });
  const rotate = useActionMutation({
    mutationFn: calendar.rotateCredential.mutationOptions,
    success: "Calendar app password created",
  });
  const revoke = useActionMutation({
    mutationFn: calendar.revokeCredential.mutationOptions,
    success: "Calendar app access revoked",
  });

  return (
    <CalendarCalDavSetupDialogView
      credential={credential.data}
      error={credential.error}
      isRevoking={revoke.isPending}
      isRotating={rotate.isPending}
      onClose={() => {
        // Mutation state holds the one-time secret until reset.
        rotate.reset();
        revoke.reset();
      }}
      onOpenChange={setQueryEnabled}
      onRevoke={async () => {
        await revoke.mutateAsync(undefined);
        await credential.refetch();
      }}
      onRotate={async () => await rotate.mutateAsync(undefined)}
    />
  );
}

export function CalendarCalDavSetupDialogView({
  credential,
  error,
  isRevoking,
  isRotating,
  onClose,
  onOpenChange,
  onRevoke,
  onRotate,
}: {
  credential: CalendarCredential | undefined;
  error: Error | null;
  isRevoking: boolean;
  isRotating: boolean;
  onClose: () => void;
  onOpenChange: (open: boolean) => void;
  onRevoke: () => Promise<void>;
  onRotate: () => Promise<CalendarRotateCredential>;
}) {
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<CalendarRotateCredential | null>(null);
  const issuanceEpoch = useRef(0);
  const onDialogOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange(nextOpen);
    if (!nextOpen) {
      issuanceEpoch.current += 1;
      setIssued(null);
      onClose();
    }
  };
  const rotateCredential = async () => {
    const epoch = issuanceEpoch.current + 1;
    issuanceEpoch.current = epoch;
    const nextIssued = await onRotate();
    if (issuanceEpoch.current === epoch) setIssued(nextIssued);
  };
  const revokeCredential = async () => {
    await onRevoke();
    setIssued(null);
  };

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <CalendarSync className="size-3" aria-hidden />
            Set up Calendar app
          </Button>
        }
      />
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Calendar app access</DialogTitle>
          <DialogDescription>
            Connect macOS or iOS Calendar for two-way Tasks and Meals.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <ErrorDisplay error={error} />
        ) : (
          <CalendarCalDavSetupContent
            credential={credential}
            issued={issued}
            isRotating={isRotating}
            isRevoking={isRevoking}
            onRotate={rotateCredential}
            onRevoke={revokeCredential}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
