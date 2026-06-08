// Cubby API base URL. The web/Workers app serves both better-auth (/api/auth)
// and tRPC (/api/trpc) from this origin.
//
// Prod is the fallback; for local dev against the web dev server, set
// EXPO_PUBLIC_API_URL to your Mac's LAN IP (NOT localhost — that resolves to the
// device/simulator itself), e.g. http://192.168.1.50:3000
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "https://cubby.nickysemenza.com";

export const TRPC_URL = `${API_BASE_URL}/api/trpc`;
