export type SessionClient = {
  label: string;
  kind: "phone" | "computer" | "terminal" | "unknown";
};

const OS_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone|iPad|iPod/u, "iOS"],
  [/Android/u, "Android"],
  [/Mac OS X|Macintosh/u, "macOS"],
  [/Windows/u, "Windows"],
  [/CrOS/u, "ChromeOS"],
  [/Linux/u, "Linux"],
];

// Order matters: Edge and Electron UAs also carry "Chrome", and Chrome UAs carry "Safari".
const BROWSER_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/Electron\//u, "Electron"],
  [/Edg\//u, "Edge"],
  [/Firefox\/|FxiOS\//u, "Firefox"],
  [/Chrome\/|CriOS\//u, "Chrome"],
  [/Safari\//u, "Safari"],
];

const NATIVE_PLATFORMS = new Map([
  ["ios", "iOS"],
  ["macos", "macOS"],
]);

/**
 * A readable client name for a session's stored User-Agent. Native clients send
 * CubbyKit's `ClientIdentity.userAgent` (`cubby-apple/<version> (<platform>; …)`);
 * sessions created before that identity carry URLSession's default
 * `<bundle name>/<build> CFNetwork/…`, which names no platform.
 */
export function describeSessionClient(
  userAgent: string | null | undefined,
): SessionClient {
  const ua = userAgent?.trim() ?? "";
  if (!ua) return { label: "Unknown client", kind: "unknown" };

  const native = /^cubby-apple\/(?<version>\S+) \((?<platform>\w+)/u.exec(
    ua,
  )?.groups;
  if (native?.version && native.platform) {
    const platform = NATIVE_PLATFORMS.get(native.platform) ?? native.platform;
    return {
      label: `Cubby app · ${platform} (${native.version})`,
      kind: native.platform === "ios" ? "phone" : "computer",
    };
  }
  const cli = /^cubby-cli\/(?<version>\S+)/u.exec(ua)?.groups;
  if (cli?.version) return { label: "Cubby CLI", kind: "terminal" };

  const legacy = /^(?<bundle>[^/]+)\/(?<build>\S+) CFNetwork\//u.exec(
    ua,
  )?.groups;
  if (legacy?.bundle && legacy.build) {
    return {
      label: `${legacy.bundle.replaceAll("%20", " ")} app (build ${legacy.build})`,
      kind: "unknown",
    };
  }

  const os = OS_PATTERNS.find(([pattern]) => pattern.test(ua))?.[1];
  const browser = BROWSER_PATTERNS.find(([pattern]) => pattern.test(ua))?.[1];
  if (!os && !browser) return { label: ua, kind: "unknown" };
  return {
    label: [browser, os].filter(Boolean).join(" · "),
    kind: os === "iOS" || os === "Android" ? "phone" : "computer",
  };
}

/** IPv6 addresses arrive fully expanded; the URL parser prints the RFC 5952 short form. */
export function compactIpAddress(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (!ip.includes(":")) return ip;
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return ip;
  }
}
