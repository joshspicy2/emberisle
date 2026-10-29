// #332 Debug: the built JS chunks stay inside a gzip size budget. Run after `npm run build`.
// Only dist/assets/*.js counts; sounds and images are not JS.
//
// Two checks (#868):
//   1. Ceiling: each chunk is under its absolute gzip size in CEILINGS below. Always runs.
//   2. Growth: each chunk grows by no more than its allowance against the base (main). Runs when a base is given:
//        node scripts/size-prove.mjs --base <dir>   <dir> is a checkout of the base commit, already built (<dir>/dist/assets)
//      CI builds the pull request's merge base into a second worktree and passes it. Without --base only the ceilings
//      run, and the script prints this command.
//      Fixture mode, used by size-delta-prove: --sizes <file.json> and --base-sizes <file.json> hold { chunkName: gzipBytes }
//      instead of a build.
//
// A normal pull request edits nothing here: growth inside the allowance passes. Growth over the allowance needs a reason in
// the PR body and the reviewer's OK; then raise ALLOWANCE for that chunk with a dated comment. The review desk lowers the
// ceilings about once a week, to the main measurement plus room.
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const DIR = "dist/assets";

// Hard ceilings, set 2026-10-19 (#868) from main's gzip sizes (index 122150 B, IslandCanvas 199470 B) plus generous room:
// +3 kB on the two big chunks, about +1 kB on the lazy ones.
const CEILINGS = [
  { name: "index", gzipBytes: 125200 },
  { name: "IslandCanvas", gzipBytes: 202500 },
  { name: "jelly-board", gzipBytes: 9000 },
  // #759: the sculpted Classic land loads as its own chunk, only when asked for (2026-10-29; measured 18.04 kB).
  { name: "classic-board", gzipBytes: 19000 },
  { name: "hex-jelly", gzipBytes: 50000 },
  { name: "harbor-jelly", gzipBytes: 11500 },
  { name: "online", gzipBytes: 9000 },
  // #899: Chat C's Sounds & stickers tab and seat bubbles load as their own chunk, prefetched by online; measured 2.20 kB.
  { name: "Reactions", gzipBytes: 2600 },
  { name: "sheets", gzipBytes: 7800 },
  { name: "moments", gzipBytes: 5700 },
  { name: "VictoryTargetSelect", gzipBytes: 1000 },
  // #538: coast inspection UI loads separately; measured 1030 B.
  { name: "DockInspection", gzipBytes: 1200 },
  { name: "HandRates", gzipBytes: 800 },
  // #832: the online-only timer ballot loads separately (2026-10-20; measured 1.20 kB).
  { name: "TurnExtensionVote", gzipBytes: 1400 },
];

// Growth allowance against the base, in gzip bytes. index is fixed at 400 B; the others take 0.33% of the base size, at least 200 B.
// #759 (2026-10-29): IslandCanvas takes 1600 B for the land look selection and status (requested and displayed look, bounded retries,
// generation-owned publication, the visibility snapshot); measured +1483 B. The PR body gives the reason; needs the reviewer's OK.
const ALLOWANCE = { index: 400, IslandCanvas: 1600 };
const ALLOWANCE_RATE = 0.0033;
const ALLOWANCE_MIN = 200;
const allowanceFor = (name, baseBytes) => ALLOWANCE[name] ?? Math.max(ALLOWANCE_MIN, Math.round(baseBytes * ALLOWANCE_RATE));

const kB = (n) => (n / 1000).toFixed(2) + " kB";
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
// Vite hashes filenames: name-<hash>.js. Match the name, a dash, and the 8-character hash (which may itself hold a dash).
const HASHED = /^(.+)-[A-Za-z0-9_-]{8}\.js$/;

// Reads root/dist/assets: { chunkName: gzipBytes }. A name with several files sums them.
function measure(root) {
  const dir = `${root}/${DIR}`;
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    console.error(`FAIL no ${dir}: run npm run build first`);
    process.exit(1);
  }
  const sizes = {};
  for (const f of files) {
    const m = HASHED.exec(f);
    const name = m ? m[1] : f;
    sizes[name] = (sizes[name] ?? 0) + gzipSync(readFileSync(`${dir}/${f}`)).length;
  }
  return sizes;
}

const readSizes = (file) => JSON.parse(readFileSync(file, "utf8"));

const pr = arg("--sizes") ? readSizes(arg("--sizes")) : measure(".");
const baseDir = arg("--base");
const base = arg("--base-sizes") ? readSizes(arg("--base-sizes")) : baseDir ? measure(baseDir) : undefined;

const fails = [];
for (const { name, gzipBytes } of CEILINGS) {
  const size = pr[name];
  if (size === undefined) {
    fails.push(name);
    console.log(`FAIL ${name}: no chunk named ${name}-*.js in ${DIR}`);
    continue;
  }
  const ok = size <= gzipBytes;
  if (!ok) fails.push(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${kB(size)} gzip, ceiling ${kB(gzipBytes)}${ok ? "" : ` (${kB(size - gzipBytes)} over)`}`);
}

const unbudgeted = Object.keys(pr).filter((n) => !CEILINGS.some((c) => c.name === n));
if (unbudgeted.length) {
  fails.push("unbudgeted");
  console.log(`FAIL chunk with no ceiling: ${unbudgeted.join(", ")}. Add it to CEILINGS.`);
}

if (base) {
  for (const { name } of CEILINGS) {
    const size = pr[name];
    if (size === undefined) continue;
    const baseBytes = base[name];
    if (baseBytes === undefined) {
      console.log(`new  ${name}: ${kB(size)} gzip, not in the base; the ceiling is its only limit`);
      continue;
    }
    const allowance = allowanceFor(name, baseBytes);
    const growth = size - baseBytes;
    const ok = growth <= allowance;
    if (!ok) fails.push(`${name} growth`);
    console.log(
      `${ok ? "ok  " : "FAIL"} ${name} growth: base ${baseBytes} B, PR ${size} B, ${growth >= 0 ? "+" : ""}${growth} B, allowance ${allowance} B` +
        (ok ? "" : ` (${growth - allowance} B over). Say why in the PR body and get the reviewer's OK, then raise ALLOWANCE in scripts/size-prove.mjs.`),
    );
  }
  for (const name of Object.keys(base)) {
    if (pr[name] === undefined) console.log(`gone ${name}: ${kB(base[name])} gzip in the base, not in this PR`);
  }
} else {
  console.log("size-prove: no base given, ceilings only. For the growth check run: node scripts/size-prove.mjs --base <dir of the base commit, built>");
}

if (fails.length) process.exit(1);
console.log(`size-prove: all chunks inside ${base ? "ceiling and growth allowance" : "ceiling"}`);
