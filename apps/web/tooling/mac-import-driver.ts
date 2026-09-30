import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Actual macOS accessibility actions; callers own the app/server/database lifecycle. */
export class MacImportDriver {
  private sequence = 0;
  private bundleID: string | undefined;
  private child: ReturnType<typeof spawn> | undefined;
  readonly evidence: string[] = [];

  constructor(
    readonly repoRoot: string,
    readonly artifacts: string,
    readonly session: string,
  ) {}

  async action(args: string[]): Promise<string> {
    const command = [
      "exec",
      "agent-device",
      ...args,
      "--platform",
      "macos",
      "--session",
      this.session,
      "--state-dir",
      path.join(this.artifacts, "agent-device-state"),
    ];
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("pnpm", command, {
        cwd: this.repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (code) => {
        this.child = undefined;
        const file = path.join(
          this.artifacts,
          `${String(++this.sequence).padStart(3, "0")}-${args[0]}.txt`,
        );
        writeFileSync(file, stdout + stderr);
        this.evidence.push(file);
        appendFileSync(
          path.join(this.artifacts, "actions.jsonl"),
          JSON.stringify({ args, status: code }) + "\n",
        );
        if (code !== 0)
          reject(
            new Error(`agent-device ${args[0]} failed: ${stdout}${stderr}`),
          );
        else resolve(stdout);
      });
    });
    return output;
  }

  interrupt(): void {
    this.child?.kill("SIGTERM");
  }

  async open(bundleID: string): Promise<string> {
    this.bundleID = bundleID;
    return this.action(["open", bundleID, "--foreground"]);
  }

  async wait(selector: string): Promise<string> {
    return this.action(["wait", selector, "30000"]);
  }

  async click(selector: string): Promise<string> {
    return this.action(["click", selector, "--settle"]);
  }

  async snapshot(): Promise<string> {
    return this.action(["snapshot", "-i"]);
  }

  async screenshot(name: string): Promise<void> {
    const output = path.join(this.artifacts, `${name}.png`);
    await this.action(["screenshot", "--out", output]);
    this.evidence.push(output);
  }

  /** NSOpenPanel's slash shortcut opens Go to Folder without hardcoded coordinates. */
  async chooseFile(file: string): Promise<void> {
    await this.wait('label="Open" role=Button');
    await this.action(["type", "/"]);
    await this.wait("role=TextField editable=true");
    await this.action([
      "fill",
      "role=TextField editable=true",
      file,
      "--settle",
    ]);
    await this.action(["type", "\n"]);
    await this.click('label="Open" role=Button');
  }

  async openSettings(): Promise<void> {
    await this.click('label="Cubby" role=MenuBarItem');
    await this.click('label="Settings…" role=MenuItem');
    await this.wait("id=settings.purchaseImport.syncNow");
  }

  async importStatement(file: string): Promise<void> {
    await this.click("id=statement.csv.chooseFile");
    await this.chooseFile(file);
    await this.wait("id=statement.csv.confirm");
  }

  async addPhotoToImportRun(file: string): Promise<void> {
    await this.click("label=Photos");
    await this.click("id=photo.source.files");
    await this.chooseFile(file);
    await this.click('label="Add to import run…"');
    await this.wait("id=photos.run.startNew");
    await this.click("id=photos.run.startNew");
  }

  async approveAllPhotoGroups(): Promise<void> {
    await this.wait("id=review.workspace");
    await this.click('label="Approve all"');
    const snapshot = await this.snapshot();
    const approval = snapshot.match(
      /(@e\d+(?:~s\d+)?)\s+[^\n]*Approve \d+ items/,
    );
    if (!approval?.[1])
      throw new Error("Photo approval confirmation is missing");
    await this.click(approval[1]);
  }

  async close(): Promise<void> {
    await this.action(["close", ...(this.bundleID ? [this.bundleID] : [])]);
  }
}
