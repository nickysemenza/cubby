# Xcode MCP: previews and device interaction

Xcode 27's MCP server renders `#Preview`s, builds, runs tests, and drives a
simulator without Xcode.app open. It is the fastest visual loop for SwiftUI:
edit → `RenderPreview` → read the PNG. Tools are `mcp__xcode__*`; the `xcode`
server is registered as `xcrun mcpbridge`.

## Setup (once per machine)

```sh
claude mcp add -s user --transport stdio xcode -- xcrun mcpbridge
sudo xcrun mcp-server enable
sudo xcrun mcp-server allow-folder <path-to>/cubby --always   # covers every worktree
```

Also Xcode → Settings → Intelligence → "Allow External Agents to Use Xcode
Tools". A new agent's first tool call fails with "isn't approved"; the operator
approves it once (dialog or `sudo xcrun mcp-server approve <id> --always`), and
a signed client such as Claude Code keeps that grant. `xcrun mcp-server status`
lists permitted agents, folders, and open workspaces. Xcode 27.0 has no
`mcp-server start`: opening a workspace starts the server.

## Session bootstrap

1. `XcodeListWorkspaces`; if none is open, `XcodeOpenWorkspace` with the
   worktree's absolute `apps/apple/Cubby.xcodeproj` path.
2. Pass the returned `workspaceIdentifier` on every call — tools reject a
   missing one even when a single workspace is open.
3. File paths are Xcode-project-relative (`Cubby/App/Shared/Today/TodayView.swift`),
   never repo-relative; `XcodeGlob` (`**/TodayView.swift`) resolves one.

## Preview loop

`RenderPreview(workspaceIdentifier, sourceFilePath, previewDefinitionIndexInFile)`
builds the active scheme (`Cubby-iOS`) and returns `previewSnapshotPath`, a PNG.

- **Timing:** the first render of a session is a cold preview build — set
  `timeout: 400`; the 120 s default fails. Warm renders take ~15 s, ~40–80 s
  after an edit that rebuilds.
- **Variants:** a response lists `supportedPreviewVariantOverrides` (color
  scheme, Dynamic Type, contrast, orientation); pass them back as
  `previewVariantOverrides` to sweep appearance without code changes.
- **Failures are text:** a crashing preview returns the crash report. A
  `PreviewFixtures.swift` `fatalError` means a fixture no longer decodes —
  regenerate it (see `apps/apple/AGENTS.md` § Generated files).
- The snapshot filename contains a non-ASCII space before `AM`/`PM`; copy it
  with a glob.

## Device loop

Use it for behavior a preview cannot show: navigation, taps, sheets, typing.

1. `DeviceInteractionStartWorkspaceSession(workspaceIdentifier, sessionIdentifier,
   deviceIdentifier)` — boots the device; start it early. `deviceIdentifier`
   takes a simulator UUID or exact name; a vague name like `iPhone` fails and the
   error lists eligible devices.
2. `DeviceInteractionInstallAndRun(workspaceIdentifier, interactionSessionKey)` —
   builds, installs, launches (~60 s warm). Rerun after every code change.
   Per-run `commandLineArguments`/`environmentVariables` beat editing the scheme.
3. `DeviceInteractionSynthesize(interactSessionKey, interactionCommand)` — runs
   the command, then captures a screenshot, a UI hierarchy with `hitPoint`
   coordinates, and app logs (~9 s). An empty command only captures. Tap
   `hitPoint`s from the latest hierarchy, never coordinates read off the
   screenshot.
4. `DeviceInteractionEndSession` when done; an open session holds the device.

Commands: `t x y` tap, `d x y` double-tap, `t x1 y1 f x2 y2 0.3` swipe,
`drag x1 y1 x2 y2`, `sender keyboard kbd <text>` (last in a chain),
`orientation landscapeLeft`, `b h` home, `w 0.5` wait. The full grammar is in
Xcode's `device-interaction` skill: `xcrun agent skills export --output-dir <dir>`.

Read the hierarchy text first; open a screenshot only for a visual question. A
signed-out app stops at the sign-in screen — the agent never enters credentials.
The session shows in Xcode's own device window. The Claude desktop app's
simulator panel (`mcp__Claude_Code_iOS_Simulator`) is a separate driver with its
own access prompt: it launches an already-built `.app`, reads the accessibility
tree, supports pinch/edge gestures and deep links, and gives the operator a live
view. Prefer the Xcode session for the edit → rebuild → verify loop (one call
rebuilds and relaunches; every capture carries app logs); prefer the panel when
the operator wants to watch or for deep-link checks.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "This agent isn't approved" | `XcodeOpenWorkspace` to raise approval; operator approves |
| "workspaceIdentifier is required" | Use an id the error lists |
| "File not found in project structure" | Project-relative path via `XcodeGlob` |
| `TaskTimeoutError` on first render | Raise `timeout`; the cold build is still running |
| "Launch session has not been found" / "Cannot find … in scope" | `BuildProject` to see errors; a stale `Cubby.xcodeproj` needs `pnpm apple gen` |
