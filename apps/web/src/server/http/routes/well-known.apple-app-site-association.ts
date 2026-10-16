import type { HttpRouteHandlers } from "~/lib/http-route-handler";
import { GET } from "~/server/http/apple-app-site-association";

// Apple universal links: iOS/macOS fetch this unauthenticated, unversioned
// path over HTTPS before opening a `cubby.nickysemenza.com/<SHORTCODE>` link
// from a printed label QR code, to decide whether to hand it to the native
// app instead of Safari.

export const handlers: HttpRouteHandlers<Record<never, never>, "GET"> = {
  GET,
};
