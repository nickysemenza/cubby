import { getAppErrorDetails } from "~/lib/error-utils";

interface PublicClient {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
}

export type PublicClientLookupState =
  | { kind: "loading" }
  | { kind: "verified"; client: PublicClient }
  | { kind: "invalid"; message: string }
  | {
      kind: "error";
      message: string;
      /** The raw transport/lookup failure — the trusted household sees this, not just the friendly line. */
      detail: string;
    };

interface PublicClientLookupResponse {
  data?: PublicClient | null;
  error?: { message?: string } | null;
}

export type PublicClientLookup = (
  clientId: string,
) => Promise<PublicClientLookupResponse>;

const MISSING_CLIENT_ID =
  "This authorization request is missing its application identifier. Return to the requesting application and start again.";
const UNKNOWN_CLIENT =
  "This application is no longer available. Return to the requesting application and start the connection again.";
const LOOKUP_FAILED =
  "Cubby could not verify this application's identity. Check your connection and try again before allowing access.";

/**
 * Consent is meaningful only after the server has returned client metadata.
 * Keep response failures distinct from an invalid/removed client so the UI can
 * offer retry only when retry could change the outcome.
 */
export async function verifyPublicClient(
  clientId: string | undefined,
  lookup: PublicClientLookup,
): Promise<PublicClientLookupState> {
  if (!clientId) return { kind: "invalid", message: MISSING_CLIENT_ID };

  try {
    const result = await lookup(clientId);
    if (result.data?.client_id === clientId) {
      return { kind: "verified", client: result.data };
    }
    if (result.data) {
      return {
        kind: "error",
        message: LOOKUP_FAILED,
        detail: "The client lookup response named a different client_id.",
      };
    }

    if (result.error) {
      return {
        kind: "error",
        message: LOOKUP_FAILED,
        detail: getAppErrorDetails(result.error).message,
      };
    }

    return { kind: "invalid", message: UNKNOWN_CLIENT };
  } catch (error) {
    return {
      kind: "error",
      message: LOOKUP_FAILED,
      detail: getAppErrorDetails(error).message,
    };
  }
}

/** The Allow control is never a fallback for a loading or unknown client. */
export function canAllowConsent(
  hydrated: boolean,
  requestedClientId: string | undefined,
  client: PublicClientLookupState,
  submitting: boolean,
) {
  return (
    hydrated &&
    client.kind === "verified" &&
    client.client.client_id === requestedClientId &&
    !submitting
  );
}
