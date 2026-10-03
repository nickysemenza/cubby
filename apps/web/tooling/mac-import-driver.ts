import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pollUntil } from "@cubby/shared/retry";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

const nodeSchema = z.object({
  index: z.number(),
  parentIndex: z.number().nullish(),
  type: z.string().nullish(),
  role: z.string().nullish(),
  subrole: z.string().nullish(),
  label: z.string().nullish(),
  value: z.string().nullish(),
  identifier: z.string().nullish(),
  rect: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullish(),
  enabled: z.boolean().nullish(),
  selected: z.boolean().nullish(),
  bundleId: z.string().nullish(),
});
type Node = z.infer<typeof nodeSchema>;
const macAppIdentity = z.object({ bundleId: z.string(), pid: z.number() });
type MacAppIdentity = z.infer<typeof macAppIdentity>;
const role = (node: Node) =>
  (node.type ?? node.role ?? "")
    .replace(/^AX/, "")
    .replaceAll("-", "")
    .toLowerCase();

function matchesRole(node: Node, value: string | undefined): boolean {
  const expected = value?.replaceAll("-", "").toLowerCase();
  return (
    role(node) === expected ||
    (expected === "cell" && role(node) === "row") ||
    (expected === "searchfield" && node.subrole === "AXSearchField")
  );
}

/** Native agent-device AX/CGEvent backend preserves the already-launched fixture process. */
export class MacImportDriver {
  private sequence = 0;
  private generation = 0;
  private bundleID: string | undefined;
  private pid: number | undefined;
  private nodes: Node[] = [];
  private aborted = false;
  readonly evidence: string[] = [];
  private readonly helper =
    process.env.AGENT_DEVICE_MACOS_HELPER_BIN ??
    path.join(
      homedir(),
      ".agent-device/macos-helper/current/agent-device-macos-helper",
    );

  constructor(
    readonly repoRoot: string,
    readonly artifacts: string,
    readonly session: string,
  ) {}

  private get presentationHelper(): string {
    return path.join(this.artifacts, "mac-presentation-ax");
  }

  private presentationAction(
    action: "press" | "scroll" | "fill" | "raise",
    containerID: string,
    value: string,
  ): boolean {
    this.guardForeground();
    try {
      execFileSync(
        this.presentationHelper,
        [
          action,
          String(this.pid),
          path.join(
            homedir(),
            "Library/Caches/CubbyMacImportFixture/Cubby.app",
          ),
          containerID,
          value,
        ],
        { timeout: 10000 },
      );
      return true;
    } catch (error) {
      if (
        action === "press" &&
        z.object({ status: z.literal(2) }).safeParse(error).success
      ) {
        this.record(
          ["AX-press-unsupported", containerID, value],
          0,
          "Owned coordinate input required",
        );
        return false;
      }
      throw error;
    }
  }

  async prepareBackend(): Promise<void> {
    const presentationSource = path.join(
      this.repoRoot,
      "apps/web/tooling/mac-presentation-ax.swift",
    );
    execFileSync(
      "xcrun",
      ["swiftc", presentationSource, "-o", this.presentationHelper],
      { timeout: 30000 },
    );
    const presentationBuild = path.join(
      this.artifacts,
      "presentation-helper-build.json",
    );
    const presentationSourceEvidence = path.join(
      this.artifacts,
      "mac-presentation-ax.swift",
    );
    writeFileSync(presentationSourceEvidence, readFileSync(presentationSource));
    writeFileSync(
      presentationBuild,
      JSON.stringify({
        sourceSHA256: createHash("sha256")
          .update(readFileSync(presentationSource))
          .digest("hex"),
        binarySHA256: createHash("sha256")
          .update(readFileSync(this.presentationHelper))
          .digest("hex"),
      }),
    );
    this.evidence.push(
      presentationBuild,
      presentationSourceEvidence,
      this.presentationHelper,
    );
    if (!process.env.AGENT_DEVICE_MACOS_HELPER_BIN) {
      const entry = import.meta.resolve("agent-device");
      // The pinned SDK owns its Swift-source fingerprint and helper build/cache.
      // This metadata-only call avoids opening or relaunching an app session.
      const helper = z
        .object({
          t: z.object({
            resolveFrontmostMacOsApp: z
              .instanceof(Function)
              .transform(
                (resolve) => async (): Promise<MacAppIdentity> =>
                  macAppIdentity.parse(await resolve()),
              ),
          }),
        })
        .parse(await import(new URL("helper.js", entry).href));
      await helper.t.resolveFrontmostMacOsApp();
    }
    const file = path.join(this.artifacts, "native-helper-build.json");
    writeFileSync(
      file,
      JSON.stringify({
        backend: "agent-device-native-macos",
        helperSHA256: createHash("sha256")
          .update(readFileSync(this.helper))
          .digest("hex"),
        explicitOverride: Boolean(process.env.AGENT_DEVICE_MACOS_HELPER_BIN),
      }),
    );
    this.evidence.push(file);
  }

  private invoke<T>(args: string[], schema: z.ZodType<T>, attempt = 0): T {
    let output: string;
    let subprocessFailure: unknown;
    try {
      output = execFileSync(this.helper, args, {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const failure = z.object({ stdout: z.string().min(1) }).safeParse(error);
      if (!failure.success) throw error;
      output = failure.data.stdout;
      subprocessFailure = error;
    }
    const envelope = z
      .object({
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .parse(JSON.parse(output));
    if (!envelope.ok) {
      const diagnostic = JSON.stringify(envelope.error);
      // SwiftUI editor transitions can briefly expose infinite AX bounds.
      // Retry observations only; no input is sent without a valid owned tree.
      if (
        args[0] === "snapshot" &&
        attempt < 3 &&
        diagnostic.includes("EncodingError.invalidValue: inf (Double)")
      ) {
        execFileSync("osascript", ["-e", "delay 0.1"], { timeout: 1000 });
        return this.invoke(args, schema, attempt + 1);
      }
      throw new Error(`Native Mac helper ${args[0]} failed: ${diagnostic}`);
    }
    if (subprocessFailure) throw subprocessFailure;
    return schema.parse(envelope.data);
  }

  // Re-activating an already-owned foreground app can disrupt its menu or key window.
  private guardForeground(attempt = 0): void {
    if (this.aborted) throw new Error("Mac driver interrupted");
    if (!this.bundleID) throw new Error("No owned Mac fixture session");
    if (!this.pid) throw new Error("No verified fixture PID");
    const activation = z
      .object({
        accepted: z.boolean(),
        bundleId: z.string(),
        pid: z.number(),
        appName: z.string(),
      })
      .parse(
        JSON.parse(
          execFileSync(
            "osascript",
            [
              "-l",
              "JavaScript",
              "-e",
              'ObjC.import("AppKit"); function run(argv) { const expectedPID=Number(argv[0]); const app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(expectedPID); if (!app || app.isTerminated || ObjC.unwrap(app.bundleIdentifier)!==argv[1]) throw Error("Owned fixture PID/bundle is not running"); const alreadyFront=$.NSWorkspace.sharedWorkspace.frontmostApplication; const accepted=Number(alreadyFront.processIdentifier)===expectedPID || app.activateWithOptions(3); const deadline=Date.now()+3000; let front; do { front=$.NSWorkspace.sharedWorkspace.frontmostApplication; if (Number(front.processIdentifier)===expectedPID && ObjC.unwrap(front.bundleIdentifier)===argv[1]) break; $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05)); } while(Date.now()<deadline); return JSON.stringify({accepted:Boolean(accepted),bundleId:ObjC.unwrap(front.bundleIdentifier)||"",pid:Number(front.processIdentifier),appName:ObjC.unwrap(front.localizedName)||""}); }',
              String(this.pid),
              this.bundleID,
            ],
            { encoding: "utf8", timeout: 10000 },
          ),
        ),
      );
    this.record(
      ["foreground-activation"],
      activation.accepted &&
        activation.pid === this.pid &&
        activation.bundleId === this.bundleID
        ? 0
        : 1,
      JSON.stringify(activation),
    );
    if (
      !activation.accepted ||
      activation.pid !== this.pid ||
      activation.bundleId !== this.bundleID
    ) {
      if (attempt < 2) return this.guardForeground(attempt + 1);
      throw new Error(
        `Owned fixture AppKit activation did not reach verified PID; observed ${activation.appName} (${activation.bundleId}) PID ${activation.pid}`,
      );
    }
    const front = this.invoke(
      ["app", "frontmost"],
      z.object({ bundleId: z.string(), pid: z.number() }),
    );
    if (
      front.bundleId !== this.bundleID ||
      (this.pid !== undefined && front.pid !== this.pid)
    ) {
      if (attempt < 2) return this.guardForeground(attempt + 1);
      throw new Error(
        `Owned fixture is not the foreground process; observed ${front.bundleId} PID ${front.pid}; refusing native input`,
      );
    }
    this.pid = front.pid;
  }

  private observe(
    surface: "frontmost-app" | "menubar" = "frontmost-app",
  ): string {
    this.guardForeground();
    const data = this.invoke(
      [
        "snapshot",
        "--surface",
        surface,
        ...(surface === "menubar" ? ["--bundle-id", this.bundleID!] : []),
      ],
      z.object({ nodes: z.array(nodeSchema) }),
    );
    // A newly launched SwiftUI window can publish its AX tree after activation.
    // Empty snapshots are readiness observations; foreign nodes still fail closed.
    if (
      data.nodes.some(
        (node) => node.bundleId && node.bundleId !== this.bundleID,
      )
    ) {
      this.record(
        ["snapshot-ownership"],
        1,
        JSON.stringify({
          nodeCount: data.nodes.length,
          expectedBundle: this.bundleID,
          observedBundles: [
            ...new Set(data.nodes.map((node) => node.bundleId).filter(Boolean)),
          ],
        }),
      );
      throw new Error(
        "Native AX snapshot did not belong exclusively to the owned fixture",
      );
    }
    this.nodes = data.nodes;
    if (
      surface === "frontmost-app" &&
      data.nodes.some((node) => role(node) === "popover")
    ) {
      const supplemental = z
        .array(nodeSchema)
        .parse(
          JSON.parse(
            execFileSync(
              this.presentationHelper,
              [
                "snapshot",
                String(this.pid),
                path.join(
                  homedir(),
                  "Library/Caches/CubbyMacImportFixture/Cubby.app",
                ),
                "*",
                "*",
              ],
              { timeout: 10000, encoding: "utf8" },
            ),
          ),
        );
      const key = (node: Node) =>
        JSON.stringify([role(node), node.identifier, node.rect]);
      const existing = new Set(this.nodes.map(key));
      let index = Math.max(-1, ...this.nodes.map((node) => node.index)) + 1;
      for (const node of supplemental) {
        if (node.bundleId !== this.bundleID)
          throw new Error("Supplemental AX snapshot ownership mismatch");
        if (!existing.has(key(node))) {
          this.nodes.push({ ...node, index: index++ });
          existing.add(key(node));
        }
      }
    }
    this.generation++;
    return this.nodes
      .map((node) => {
        const type = role(node) === "row" ? "cell" : role(node);
        const text = node.label ?? node.value ?? "";
        return `@e${node.index + 1}~s${this.generation} [${type}] ${JSON.stringify(text)}${node.identifier ? ` id=${node.identifier}` : ""}${node.selected ? " [selected]" : ""}${node.enabled === false ? " [disabled]" : ""}`;
      })
      .join("\n");
  }

  private matching(selector: string): Node[] {
    const ref = selector.match(/^@e(\d+)(?:~s(\d+))?$/);
    if (ref) {
      if (ref[2] && Number(ref[2]) !== this.generation)
        throw new Error("Stale native snapshot reference");
      return this.nodes.filter((node) => node.index + 1 === Number(ref[1]));
    }
    const parts = [...selector.matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)];
    if (!parts.length)
      throw new Error(`Unsupported native selector: ${selector}`);
    return this.nodes.filter((node) =>
      parts.every((part) => {
        const key = part[1],
          value = part[2] ?? part[3];
        switch (key) {
          case "id":
            return node.identifier === value;
          case "text":
          case "label":
            return node.label === value || node.value === value;
          case "contains":
            return Boolean(
              (node.label ?? node.value ?? "").includes(value ?? ""),
            );
          case "role":
            return matchesRole(node, value);
          case "editable":
            return (
              value === "true" &&
              ["textfield", "searchfield", "textview"].includes(role(node))
            );
          case "selected":
            return Boolean(node.selected) === (value === "true");
          default:
            throw new Error(`Unsupported native selector key: ${key}`);
        }
      }),
    );
  }

  private buttonContainer(node: Node): string | undefined {
    let current: Node | undefined = node;
    for (let depth = 0; current && depth < 32; depth++) {
      if (["window", "popover"].includes(role(current)) && current.identifier)
        return current.identifier;
      const parentIndex: Node["parentIndex"] = current.parentIndex;
      current =
        parentIndex == null
          ? undefined
          : this.nodes.find((entry) => entry.index === parentIndex);
    }
    return undefined;
  }

  private press(selector: string, containerID?: string): string {
    const surface = /role=Menu/.test(selector) ? "menubar" : "frontmost-app";
    if (!selector.startsWith("@")) {
      const before = this.observe(surface);
      this.record(["before-click", selector], 0, before);
    }
    const container = containerID
      ? this.matching(`id=${containerID}`)[0]?.rect
      : null;
    if (containerID && !container)
      throw new Error(`Native click container is absent: ${containerID}`);
    const matches = this.matching(selector).filter(
      (node) =>
        !["statictext", "text", "group", "application", "window"].includes(
          role(node),
        ) &&
        node.enabled !== false &&
        node.rect &&
        node.rect.width > 0 &&
        node.rect.height > 0 &&
        (!container ||
          (node.rect.x >= container.x &&
            node.rect.y >= container.y &&
            node.rect.x + node.rect.width <= container.x + container.width &&
            node.rect.y + node.rect.height <= container.y + container.height)),
    );
    const node = matches[0];
    if (matches.length !== 1 || !node?.rect)
      throw new Error(
        `Expected one finite actionable native target: ${selector} (${matches.length})`,
      );
    this.guardForeground();
    const x = node.rect.x + node.rect.width / 2,
      y = node.rect.y + node.rect.height / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new Error("Native target has invalid bounds");
    const readHit = () =>
      this.invoke(
        [
          "read",
          "--x",
          String(x),
          "--y",
          String(y),
          "--bundle-id",
          this.bundleID!,
        ],
        z.object({ text: z.string() }),
      );
    const deadline = Date.now() + 3000;
    let hit: { text: string };
    while (true) {
      try {
        hit = readHit();
        break;
      } catch (error) {
        if (Date.now() >= deadline) {
          this.record(
            ["owned-point-failure", selector],
            1,
            JSON.stringify({
              x,
              y,
              target: node.rect,
              windows: this.nodes
                .filter((entry) => role(entry) === "window")
                .map((entry) => ({ id: entry.identifier, rect: entry.rect })),
              ownedPID: this.pid,
            }),
          );
          throw error;
        }
        this.guardForeground();
      }
    }
    this.record(
      ["owned-point", selector],
      0,
      JSON.stringify({ x, y, text: hit.text, ownedPID: this.pid }),
    );
    const buttonScope = containerID ?? this.buttonContainer(node);
    const pressed =
      buttonScope && role(node) === "button" && node.identifier
        ? this.presentationAction("press", buttonScope, node.identifier)
        : false;
    if (!pressed) {
      this.invoke(
        [
          "press",
          "--x",
          String(x),
          "--y",
          String(y),
          "--bundle-id",
          this.bundleID!,
        ],
        z.object({}).passthrough(),
      );
    }
    return this.observe(surface);
  }

  private keyboard(text: string, replace: boolean, picker = false): string {
    this.observe();
    const filePicker =
      this.nodes.some((node) => role(node) === "sheet") &&
      this.nodes.some(
        (node) => node.label === "Open" && role(node) === "button",
      );
    const entityPicker =
      this.nodes.some((node) =>
        [
          "choose vendor",
          "choose purchase",
          "choose spending category",
        ].includes((node.label ?? "").toLowerCase()),
      ) &&
      this.nodes.some(
        (node) =>
          role(node) === "searchfield" || node.subrole === "AXSearchField",
      );
    if (!(picker ? entityPicker : filePicker))
      throw new Error(
        picker
          ? "Native text entry requires the owned booking picker"
          : "Native keyboard entry requires the owned file picker",
      );
    this.guardForeground();
    const script =
      text === "/"
        ? 'on run argv\n tell application "System Events" to keystroke "g" using {command down, shift down}\nend run'
        : text === "\n"
          ? 'on run argv\n tell application "System Events" to key code 36\nend run'
          : `on run argv\n tell application "System Events"\n ${replace ? 'keystroke "a" using command down\n' : ""} keystroke (item 1 of argv)\n end tell\nend run`;
    execFileSync("osascript", ["-e", script, text], { timeout: 10000 });
    return this.observe();
  }

  async action(args: string[]): Promise<string> {
    const started = Date.now();
    let output = "",
      status = 0;
    try {
      switch (args[0]) {
        case "snapshot":
          output = this.observe();
          break;
        case "click":
          output = this.press(args[1]!, args[2]);
          break;
        case "type":
          output = this.keyboard(args[1]!, false);
          break;
        case "picker-search":
          this.press("role=SearchField editable=true");
          output = this.keyboard(args[1]!, true, true);
          break;
        case "select-files":
          this.observe();
          if (
            !this.nodes.some(
              (node) => node.label === "Open" && role(node) === "button",
            ) ||
            !this.nodes.some((node) =>
              (node.label ?? "").includes("synthetic-shirt.png"),
            ) ||
            !this.nodes.some((node) =>
              (node.label ?? "").includes("synthetic-label.png"),
            )
          )
            throw new Error(
              "Expected the owned two-image fixture directory in NSOpenPanel",
            );
          this.guardForeground();
          execFileSync(
            "osascript",
            [
              "-e",
              'tell application "System Events" to keystroke "a" using command down',
            ],
            { timeout: 10000 },
          );
          output = this.observe();
          break;
        case "fill":
          this.press(args[1]!);
          if (args[1] === "id=PathTextField") {
            this.presentationAction("fill", "PathTextField", args[2]!);
            output = this.observe();
          } else output = this.keyboard(args[2]!, true);
          break;
        default:
          throw new Error(`Unsupported native action: ${args[0]}`);
      }
      return output;
    } catch (error) {
      status = 1;
      output = String(error);
      throw error;
    } finally {
      this.record(args, status, output, started);
    }
  }

  private record(
    args: string[],
    status: number,
    output: string,
    started = Date.now(),
  ): void {
    const file = path.join(
      this.artifacts,
      `${createHash("sha256").update(this.session).digest("hex").slice(0, 8)}-${String(++this.sequence).padStart(3, "0")}-${args[0]}.txt`,
    );
    writeFileSync(file, output);
    this.evidence.push(file);
    appendFileSync(
      path.join(this.artifacts, "actions.jsonl"),
      JSON.stringify({
        args,
        status,
        durationMs: Date.now() - started,
        backend: "agent-device-native-macos",
        ownedPID: this.pid,
      }) + "\n",
    );
  }

  helperFingerprint(): string {
    return createHash("sha256").update(readFileSync(this.helper)).digest("hex");
  }

  interrupt(): void {
    this.aborted = true;
  }
  async open(bundleID: string, expectedPID: number): Promise<string> {
    if (
      !/^(?:com\.nickysemenza\.cubby\.e2e|com\.cubby\.fixture\.browser)(?:\.[a-f\d]{16})?$/.test(
        bundleID,
      )
    )
      throw new Error("Native driver requires an isolated fixture bundle");
    if (!Number.isInteger(expectedPID) || expectedPID <= 0)
      throw new Error("Native driver requires a verified fixture PID");
    this.pid = expectedPID;
    this.bundleID = bundleID;
    return this.snapshot();
  }
  async snapshot(): Promise<string> {
    return this.action(["snapshot", "-i"]);
  }
  async click(selector: string, containerID?: string): Promise<string> {
    const settings = selector.startsWith("id=settings.");
    const scope =
      containerID ??
      (settings ? "com_apple_SwiftUI_Settings_window" : undefined);
    if (settings)
      await this.scrollTo(selector, "com_apple_SwiftUI_Settings_window");
    return this.action(["click", selector, ...(scope ? [scope] : [])]);
  }
  async wait(selector: string): Promise<string> {
    const started = Date.now();
    let output = "";
    try {
      await pollUntil(
        () => {
          output = this.observe();
          return this.matching(selector).length ? true : undefined;
        },
        { label: `native wait ${selector}`, timeoutMs: 30000 },
      );
    } catch {
      this.record(["wait", selector], 1, output, started);
      throw new Error(`Native wait timed out: ${selector}`);
    }
    this.record(["wait", selector], 0, output, started);
    return output;
  }
  async waitAbsent(selector: string): Promise<void> {
    const started = Date.now();
    let output = "";
    try {
      await pollUntil(
        () => {
          output = this.observe();
          return this.matching(selector).length ? undefined : true;
        },
        { label: `native absence of ${selector}`, timeoutMs: 30000 },
      );
    } catch {
      this.record(["wait-absent", selector], 1, output, started);
      throw new Error(`Native element did not dismiss: ${selector}`);
    }
    this.record(["wait-absent", selector], 0, output, started);
  }
  async scrollTo(
    selector: string,
    containerID: string,
    direction: "up" | "down" = "down",
  ): Promise<void> {
    const started = Date.now();
    let output = "";
    while (Date.now() - started < 30000) {
      output = this.observe();
      const container = this.matching(`id=${containerID}`)[0]?.rect;
      const windows = this.nodes
        .filter((node) => ["window", "popover"].includes(role(node)))
        .flatMap((node) => (node.rect ? [node.rect] : []));
      if (
        container &&
        this.matching(selector).some((node) => {
          const rect = node.rect;
          return windows.some(
            (window) =>
              rect &&
              rect.width > 0 &&
              rect.height > 0 &&
              rect.x >= Math.max(container.x, window.x) &&
              rect.y >= Math.max(container.y, window.y) &&
              rect.x + rect.width <=
                Math.min(
                  container.x + container.width,
                  window.x + window.width,
                ) &&
              rect.y + rect.height <=
                Math.min(
                  container.y + container.height,
                  window.y + window.height,
                ),
          );
        })
      ) {
        this.record(["visible", selector, containerID], 0, output, started);
        return;
      }
      if (container) {
        this.guardForeground();
        this.presentationAction(
          "scroll",
          containerID,
          direction === "down" ? "0.15" : "-0.15",
        );
      }
      await setTimeout(250);
    }
    this.record(["visible", selector, containerID], 1, output, started);
    throw new Error(
      `Native element did not become visible: ${selector} in ${containerID}`,
    );
  }
  async screenshot(name: string): Promise<void> {
    this.guardForeground();
    const script =
      'ObjC.import("CoreGraphics"); function run(argv) { const pid=Number(argv[0]); const windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))); const own=windows.filter(w => Number(w.kCGWindowOwnerPID)===pid && Number(w.kCGWindowLayer)===0); own.sort((a,b)=>b.kCGWindowBounds.Width*b.kCGWindowBounds.Height-a.kCGWindowBounds.Width*a.kCGWindowBounds.Height); if (!own.length) throw Error("No owned fixture window"); return String(own[0].kCGWindowNumber); }';
    const windowID = execFileSync(
      "osascript",
      ["-l", "JavaScript", "-e", script, String(this.pid)],
      { encoding: "utf8", timeout: 10000 },
    ).trim();
    if (!/^\d+$/.test(windowID))
      throw new Error("Invalid owned fixture window identity");
    const file = path.join(this.artifacts, `${name}.png`);
    execFileSync("screencapture", ["-x", "-o", "-l", windowID, file], {
      timeout: 10000,
    });
    this.evidence.push(file);
    this.record(
      ["screenshot", name],
      0,
      JSON.stringify({ ownedPID: this.pid, windowID }),
    );
  }
  async clickSidebar(label: "Browse" | "Photos"): Promise<void> {
    // CubbyCommands binds Photos/Browse to the fourth/fifth AppSection tabs.
    this.nativeShortcut(label === "Photos" ? 21 : 23, label);
    await this.wait(`label="${label}" role=window`);
    this.guardForeground();
    // View commands can change the main destination while Settings remains key.
    // Raise the owned main window before invoking a file importer or sheet.
    this.presentationAction("raise", "main", "");
    this.record(["raise-main-window", label], 0, this.observe());
  }
  private nativeShortcut(keyCode: number, label: string): void {
    this.guardForeground();
    execFileSync(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        'ObjC.import("CoreGraphics"); function run(argv) { const pid=Number(argv[0]); const key=Number(argv[1]); for (const down of [true,false]) { const event=$.CGEventCreateKeyboardEvent(null,key,down); $.CGEventSetFlags(event,1<<20); $.CGEventPostToPid(pid,event); } }',
        String(this.pid),
        String(keyCode),
      ],
      { timeout: 10000 },
    );
    this.record(["owned-shortcut", label], 0, this.observe());
  }
  async openStatementImport(): Promise<void> {
    await this.click("id=browse.importStatement");
    await this.wait("id=statement.csv.chooseFile");
  }
  async chooseFile(file: string): Promise<void> {
    await this.wait('label="Open" role=Button');
    await this.action(["type", "/"]);
    await this.wait("id=PathTextField");
    await this.action(["fill", "id=PathTextField", file]);
    await this.wait(`id="${file}"`);
    await this.action(["type", "\n"]);
    await this.click('label="Open" role=Button');
  }
  async openSettings(): Promise<void> {
    this.observe();
    const existing = this.matching("id=com_apple_SwiftUI_Settings_window");
    // Browser capture changes focus; raise the existing owned window directly.
    if (existing.length) {
      this.presentationAction("raise", "com_apple_SwiftUI_Settings_window", "");
      this.record(["raise-settings-window"], 0, this.observe());
    } else {
      this.nativeShortcut(43, "Settings");
    }
    await this.wait('label="Settings" role=window');
    await this.wait("id=settings.purchaseImport.syncNow");
  }
  async importStatement(file: string): Promise<void> {
    await this.click("id=statement.csv.chooseFile");
    await this.chooseFile(file);
    await this.wait("id=statement.csv.confirm");
  }
  async openEntity(code: string, appPath: string): Promise<void> {
    if (!/^[A-Z]+-[A-Z0-9]+$/.test(code))
      throw new Error("Invalid fixture entity deep link");
    this.guardForeground();
    const before = execFileSync(
      "ps",
      ["-p", String(this.pid), "-o", "command="],
      { encoding: "utf8" },
    );
    if (
      !before.startsWith(`${appPath}/Contents/MacOS/Cubby `) ||
      !before.includes("--cubby-e2e-server http://127.0.0.1:")
    )
      throw new Error(
        "Fixture deep link requires preserved app launch arguments",
      );
    execFileSync("open", ["-a", appPath, `cubby://entity/${code}`], {
      timeout: 10000,
    });
    this.guardForeground();
    const after = execFileSync(
      "ps",
      ["-p", String(this.pid), "-o", "command="],
      { encoding: "utf8" },
    );
    if (before !== after)
      throw new Error(
        "Fixture deep link changed the owned app process arguments",
      );
    this.record(["production-deep-link", code], 0, await this.snapshot());
  }
  async pickBookingEntity(control: string, title: string): Promise<void> {
    await this.click(`id=${control}`);
    await this.action(["picker-search", title]);
    await this.wait(`contains="${title}" role=Button`);
    await this.click(`contains="${title}" role=Button`);
  }
  async addPhotosToImportRun(directory: string): Promise<void> {
    await this.clickSidebar("Photos");
    await this.click("id=photo.source.files");
    await this.wait('label="Open" role=Button');
    await this.action(["type", "/"]);
    await this.wait("id=PathTextField");
    await this.action(["fill", "id=PathTextField", directory]);
    await this.wait(`id="${directory}"`);
    await this.action(["type", "\n"]);
    await this.wait('contains="synthetic-shirt.png"');
    await this.action(["select-files"]);
    await this.click('label="Open" role=Button');
    await this.wait("id=photos.review.continue");
    await this.click("id=photos.review.continue");
    await this.wait('label="Add to import run…"');
    await this.click('label="Add to import run…"');
    await this.wait("id=photos.run.startNew");
    await this.click("id=photos.run.startNew");
  }
  async approveAllPhotoGroups(): Promise<void> {
    await this.wait("id=review.workspace");
    await this.click('label="Approve all"');
    const snapshot = await this.snapshot(),
      target = snapshot.match(/(@e\d+(?:~s\d+)?)\s+[^\n]*Approve \d+ items/);
    if (!target?.[1]) throw new Error("Photo approval confirmation missing");
    await this.click(target[1]);
  }
  async close(): Promise<void> {
    if (!this.bundleID) return;
    // The launch owner terminates its verified PID and waits for exit before releasing the host lease.
    this.record(["detach", this.bundleID], 0, "Fixture UI adapter detached");
    this.bundleID = undefined;
    this.pid = undefined;
  }
}
