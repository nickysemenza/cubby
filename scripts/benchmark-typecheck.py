#!/usr/bin/env python3
"""Compare native tsc in an idle Linux checkout with generated inputs ready.

Run `python3 scripts/benchmark-typecheck.py baseline`, then repeat with each
variant name after applying that experiment and regenerating. This temporarily
edits two probe files and always restores them. Results are compiler-only;
installation, WASM, generation, Nx and pnpm startup are excluded.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variant")
    parser.add_argument("--project", default="apps/web/tsconfig.json")
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--cold-only", action="store_true")
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    root = Path(__file__).resolve().parents[1]
    output = root / "artifacts/tsc-experiments"
    output.mkdir(parents=True, exist_ok=True)
    config = root / args.project
    buildinfo = config.with_suffix(".tsbuildinfo")
    project_slug = args.project.replace("/", "-")
    expected_path = output / (project_slug + ".diagnostics.json")
    command = [
        "node", str(root / "node_modules/typescript/bin/tsc"),
        "--noEmit", "--checkers", "1", "-p", str(config),
        "--extendedDiagnostics",
    ]

    def run(name):
        log_path = output / f"{args.variant}-{project_slug}-{name}.log"
        start = time.monotonic()
        with log_path.open("w") as log:
            process = subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT)
            try:
                _, status, usage = os.wait4(process.pid, 0)
                process.returncode = os.waitstatus_to_exitcode(status)
            except BaseException:
                process.terminate()
                process.wait()
                raise
        result = {
            "variant": args.variant, "run": name, "project": args.project,
            "exit": process.returncode,
            "wall_s": round(time.monotonic() - start, 3),
            "cpu_s": round(usage.ru_utime + usage.ru_stime, 3),
            "peak_rss_kib": usage.ru_maxrss,
        }
        text = log_path.read_text()
        for field in ("Types", "Instantiations", "Files", "Check time", "Total time"):
            match = re.search(r"^" + re.escape(field) + r":\s*(.+)$", text, re.MULTILINE)
            if match:
                result[field] = match.group(1)
        with (output / "results.jsonl").open("a") as log:
            log.write(json.dumps(result) + "\n")
        print(json.dumps(result), flush=True)
        diagnostics = [line for line in text.splitlines() if "error TS" in line]
        if args.variant == "baseline" and name == "1-cold":
            expected_path.write_text(json.dumps(diagnostics, indent=2) + "\n")
        expected = json.loads(expected_path.read_text())
        if diagnostics != expected or (process.returncode and not diagnostics):
            raise RuntimeError(f"Unexpected compiler diagnostics; inspect {log_path}")

    probes = [
        (
            "body", "apps/web/src/lib/unit-price-format.ts",
            "const magnitude = Math.abs(price);",
            "const magnitude = Math.abs(price) + 0;",
        ),
        (
            "export", "apps/web/src/lib/unit-price-format.ts", None,
            "\nexport type TypecheckExperiment = { readonly value: string };\n",
        ),
        (
            "schema", "packages/schemas/src/device-fields.ts",
            'z.enum(["ios", "macos"])',
            'z.enum(["ios", "macos"]).describe("Synthetic platform contract")',
        ),
    ]
    for repeat in range(1, args.repeats + 1):
        buildinfo.unlink(missing_ok=True)
        run(f"{repeat}-cold")
        pristine = buildinfo.read_bytes()
        run(f"{repeat}-warm")
        if args.cold_only:
            continue
        for mode, relative_path, before, after in probes:
            path = root / relative_path
            original = path.read_text()
            if before is not None and original.count(before) != 1:
                raise RuntimeError(f"Probe no longer matches exactly once: {relative_path}")
            changed = original + after if before is None else original.replace(before, after)
            buildinfo.write_bytes(pristine)
            try:
                path.write_text(changed)
                run(f"{repeat}-{mode}")
            finally:
                path.write_text(original)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    main()
