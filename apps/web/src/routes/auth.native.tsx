import type { NativeCallbackScheme } from "@cubby/shared/apple-app-identity";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuthEntryFrame } from "~/app/auth/auth-entry-frame";
import { createCubbyAuthClient } from "~/lib/auth-client";
import { getAppErrorDetails } from "~/lib/error-utils";
import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";
import {
  nativeAuthSearch,
  nativeAuthDefaults,
  nativeAuthCallbackURLs,
} from "~/lib/native-auth";
import { pageTitle } from "~/lib/page-title";
import { Button } from "~/ui/primitives/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/ui/primitives/card";

export const Route = createFileRoute("/auth/native")({
  validateSearch: nativeAuthSearch,
  search: { middlewares: [stripSearchParams(nativeAuthDefaults)] },
  head: () => ({ meta: [{ title: pageTitle("Sign in to the app") }] }),
  component: NativeAuthPage,
});

function NativeAuthPage() {
  const search = Route.useSearch();
  const authClient = useMemo(
    () => createCubbyAuthClient(search.callback_scheme),
    [search.callback_scheme],
  );

  return (
    <AuthEntryFrame>
      {search.complete ? (
        <NativeAuthCompletion authClient={authClient} />
      ) : (
        <NativeAuthStart
          state={search.state}
          codeChallenge={search.code_challenge}
          codeChallengeMethod={search.code_challenge_method}
          googleError={search.google_error === true}
          authClient={authClient}
          callbackScheme={search.callback_scheme}
        />
      )}
    </AuthEntryFrame>
  );
}

function NativeAuthCompletion({
  authClient,
}: {
  authClient: ReturnType<typeof createCubbyAuthClient>;
}) {
  useEffect(() => {
    const interval = authClient.ensureElectronRedirect();
    return () => clearInterval(interval);
  }, [authClient]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Returning to Cubby</CardTitle>
        <CardDescription>
          Google sign-in is complete. Cubby should reopen automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          You can close this window after the app opens.
        </p>
      </CardContent>
    </Card>
  );
}

function NativeAuthStart({
  state,
  codeChallenge,
  codeChallengeMethod,
  googleError,
  authClient,
  callbackScheme,
}: {
  state: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
  googleError: boolean;
  authClient: ReturnType<typeof createCubbyAuthClient>;
  callbackScheme: NativeCallbackScheme;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const validRequest =
    Boolean(state && codeChallenge) && codeChallengeMethod === "S256";

  const signIn = useCallback(async () => {
    if (!state || !codeChallenge || codeChallengeMethod !== "S256") return;
    setBusy(true);
    setError(undefined);
    try {
      const callbackURLs = nativeAuthCallbackURLs(
        callbackScheme,
        state,
        codeChallenge,
      );
      const result = await authClient.signIn.social(
        {
          provider: "google",
          ...callbackURLs,
          requestSignUp: false,
          scopes: [GMAIL_READONLY_SCOPE],
        },
        {
          query: {
            client_id: "cubby-native",
            state,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
          },
        },
      );
      if (result.error) {
        setError(
          result.error.message || "Google sign-in could not be started.",
        );
      }
    } catch (error) {
      setError(getAppErrorDetails(error).message);
    } finally {
      setBusy(false);
    }
  }, [authClient, callbackScheme, codeChallenge, codeChallengeMethod, state]);

  useEffect(() => {
    if (!validRequest || googleError || started.current) return;
    started.current = true;
    void signIn();
  }, [googleError, signIn, validRequest]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in to the Cubby app</CardTitle>
        <CardDescription>
          Continue with Google to sign in and grant read-only Gmail access for
          matching orders and receipts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {googleError ? (
          <p role="alert" className="text-sm text-destructive">
            Google sign-in requires read-only Gmail access. Try again and
            approve the Gmail permission.
          </p>
        ) : null}
        {validRequest && (googleError || error) ? (
          <Button
            type="button"
            className="w-full"
            disabled={busy}
            onClick={() => void signIn()}
          >
            {busy ? "Opening Google…" : "Try Google again"}
          </Button>
        ) : !validRequest ? (
          <p role="alert" className="text-sm text-destructive">
            This sign-in request is invalid. Return to the Cubby app and try
            again.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Opening Google…</p>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
