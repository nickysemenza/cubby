// Type-only firewall between the tRPC server and its client apps (web + mobile).
//
// Client apps import the `AppRouter` TYPE from here to type their tRPC clients
// end-to-end. Because it is consumed via `import type`, the bundler erases it and
// ZERO server runtime (drizzle/pg/better-auth/Sentry/OTel/CF bindings) ships to
// React Native — which would otherwise break Metro.
//
// NOTE: the AppRouter type is sourced from the web server via the `~` path alias.
// Any package that consumes this type must map `~/*` -> `apps/web/src/*` in its
// own tsconfig (see this package's tsconfig.json and the mobile app's tsconfig).
export type { AppRouter } from "~/server/api/root";

export type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export { getAppErrorDetails, isTRPCClientError } from "./errors";
export type { AppErrorDetails } from "./errors";
