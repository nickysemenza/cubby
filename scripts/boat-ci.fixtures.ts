import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function fakeBoatFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-boat-regression-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init");
  writeFileSync(
    path.join(root, ".gitignore"),
    "/bin/\n/artifacts/\n/created\n/manifest.json\n/deleted\n/summary\n/output\n",
  );
  git("add", ".gitignore");
  git(
    "-c",
    "user.name=Synthetic CI",
    "-c",
    "user.email=ci@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "test: synthetic source revision",
  );
  const executable = path.join(bin, "boat");
  writeFileSync(
    executable,
    `#!${process.execPath}
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = process.env.FAKE_BOAT_ROOT;
const args = process.argv.slice(2);
const log = (value) => console.log(JSON.stringify(value));
if (args[0] === 'limits') log({canStart: process.env.FAKE_NO_CAPACITY !== '1', creditBalanceSeconds: 1000});
else if (args[0] === 'new') { writeFileSync(path.join(root, 'created'), 'yes'); log({event:'ready',id:'bx_synthetic'}); }
else if (args[0] === 'exec') {
  if (!args.includes('--json')) process.exit(3);
  if (process.env.FAKE_FAILURE === '1') {
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const job = manifest.jobs[0];
    log({type:'stdout',data:'CUBBY_BOAT_RESULT '+JSON.stringify({id:job.id, command:job.run, revision:manifest.revision, tree:manifest.tree, exitCode:1, durationMs:10, sourceClean:true, evidenceComplete:true})+'\\n'});
  }
  if (process.env.FAKE_WAIT === '1') { console.log('FAKE_RUNNING'); setTimeout(() => {}, 30000); }
} else if (args[0] === 'scp' && args[1] === '-r') {
  if (process.env.FAKE_SKIP_COLLECTION === '1') process.exit(0);
  if (process.env.FAKE_COLLECTION_FAILURE === '1') process.exit(2);
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  let reports = manifest.jobs.map((job, index) => ({id:job.id, command:job.run, revision:manifest.revision, tree:manifest.tree, exitCode:process.env.FAKE_FAILURE==='1' && index===0 ? 1 : 0, durationMs:10, sourceClean:true, evidenceComplete:true}));
  for (const job of manifest.jobs) {
    const web = path.join(args[3], job.id, 'apps/web');
    mkdirSync(path.join(web, 'playwright-report'), {recursive:true});
    mkdirSync(path.join(web, 'blob-report'), {recursive:true});
    writeFileSync(path.join(web, 'playwright-report/run-manifest.json'), JSON.stringify({status:'passed',source:{commit:manifest.revision,dirty:false},cases:[{status:'passed'}]}));
    writeFileSync(path.join(web, 'blob-report/report.zip'), 'synthetic blob');
    writeFileSync(path.join(web, '.vitest-results.json'), JSON.stringify({success:process.env.FAKE_REPORT_FAILURE!=='1',numTotalTests:1,numFailedTests:process.env.FAKE_REPORT_FAILURE==='1'?1:0}));
  }
  if (process.env.FAKE_MISSING === '1') reports = reports.slice(0, 1);
  writeFileSync(path.join(args[3], 'results.json'), JSON.stringify(reports));
} else if (args[0] === 'scp') writeFileSync(path.join(root, 'manifest.json'), readFileSync(args[1]));
else if (args[0] === 'delete') writeFileSync(path.join(root, 'deleted'), 'yes');
else { console.error('Unexpected fake provider operation', args[0]); process.exit(2); }
`,
  );
  chmodSync(executable, 0o700);
  return {
    root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      BOAT_EXECUTOR: "boat",
      BOAT_CI_ENABLED: "true",
      BOAT_API_KEY: "synthetic-ci-token",
      BOAT_CI_SNAPSHOT: "synthetic-ci-base",
      BOAT_MACHINES: "1",
      BOAT_E2E_SHARDS: "2",
      BOAT_POSTGRES_SHARDS: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: path.join(root, "output"),
      GITHUB_STEP_SUMMARY: path.join(root, "summary"),
      FAKE_BOAT_ROOT: root,
    },
    script: `import { coordinatePilot } from ${JSON.stringify(new URL("./boat-ci.ts", import.meta.url).href)}; await coordinatePilot(${JSON.stringify(root)});`,
  };
}
