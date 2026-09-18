// The app target compiles with `MemberImportVisibility`, so members of generated API
// types (enum cases, memberwise inits) are visible in a file only when their defining
// module is imported there directly or through an `@_exported import`. Re-exporting from
// CubbyKit keeps the rule in apps/apple/AGENTS.md intact: hand-written Swift still names
// generated types only through the `Generated/APITypes.swift` aliases and never imports
// `CubbyAPI` itself.
@_exported import CubbyAPI
@_exported import CubbyAPISupport

/// Package-level metadata for `CubbyKit`.
public enum CubbyKitInfo {
    public static let version = "0.1.0"
}
