/** Both browser engines must observe the hydrated authenticated shell. */
export const AUTHENTICATED_SHELL_READY =
  '[data-app-shell="authenticated"][data-hydrated="true"]';

/** Prevent synthetic acceptance sessions and errors from reaching browser Sentry. */
export function disableBrowserSentry() {
  Object.defineProperty(window, "__CUBBY_E2E_DISABLE_SENTRY__", {
    value: true,
  });
}
