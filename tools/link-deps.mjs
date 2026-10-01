/**
 * Junction the three packages `lib/compaction.js` imports but must not vendor.
 *
 * WHY THIS EXISTS: `lib/compaction.js` resolves its base class by bare name, and Node
 * walks UP from the module's real path. Two layouts, two answers:
 *   - checkout (dev, tests): walking up from `lib/` reaches THIS directory.
 *   - desktop install: `dsh plugin add` copies the package into
 *     `$DSH_HOME/profiles/<p>/node_modules/dsh-jev-manager` as a real directory with no
 *     `node_modules` of its own, so the walk lands on the profile's shared
 *     `$DSH_HOME/profiles/node_modules`. The app's own harness sits in
 *     `resources/app.asar`, which Node's resolver cannot reach. Without a junction there
 *     the provider finds no base class and degrades to DSH's stock compaction — safely,
 *     but silently, so this tool is what makes the feature actually run on desktop.
 * Point it at the app's runtime with DSH_RUNTIME_ROOT so the junction targets the SAME
 * copy the process is running; a stale sibling copy binds the wrong class.
 *
 * Junctions, not copies: a DSH upgrade then updates what this plugin loads with no
 * re-run, and Windows junctions need no administrator rights.
 *
 *   node tools/link-deps.mjs                  # the checkout (default)
 *   node tools/link-deps.mjs --shared         # $DSH_HOME/profiles/node_modules (desktop)
 *   node tools/link-deps.mjs --dest <dir>     # an explicit node_modules directory
 *   node tools/link-deps.mjs --check [--shared]   # report only
 *   node tools/link-deps.mjs --remove [--shared]  # delete the junctions WE made, never the targets
 *
 * `--remove` proves authorship before deleting (tools/link-ownership.mjs): the checkout's own
 * `node_modules` is ours outright, a shared directory needs a matching entry in this plugin's
 * ledger (`$DSH_HOME/jev-manager/links.json`, written when the link is created), and a dangling
 * link into the app's `app.asar` is the desktop bridge. Anything else is reported and left
 * alone; `--force` overrides.
 */

import { homedir } from 'node:os';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateDir } from '../lib/features.mjs';
import { canonicalPath, foreignLinkReason } from './link-ownership.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages this plugin imports by bare name and must not vendor. */
const WANTED = [
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-session',
];

function lstatSafe(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function realpathSafe(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Is `path` a link WE could have made?  `readlinkSync` answers for both symlinks and
 * Windows junctions and throws EINVAL on a real directory, which `lstatSync().isSymbolicLink()`
 * does not do reliably for a junction.
 */
function readlinkSafe(path) {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/**
 * Runtimes the caller named explicitly, tried before the machine-wide defaults. Naming one
 * decides which harness the links point at; it says nothing about who made an existing link
 * — that is the ledger's job, because with nothing named here the fallback is the very npm
 * install the harness's own shared junctions point at.
 */
function namedRoots() {
  const roots = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) roots.push(resolve(value.trim()));
  };
  add(process.env.DSH_RUNTIME_ROOT);
  add(process.env.DSH_APP_DIR);
  return roots;
}

/**
 * This plugin's record of the junctions it created, under its own state directory next to
 * `features.json`. It is what makes `--remove` able to tell "ours" from "the harness's
 * identical-looking one" in `$DSH_HOME/profiles/node_modules`, where a target comparison
 * cannot (both point at the same npm install). It is deleted with the rest of the state by
 * `uninstall.mjs`.
 */
const ledgerPath = () => join(stateDir(), 'links.json');

function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(ledger) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(ledgerPath(), `${JSON.stringify(ledger, null, 2)}\n`);
  } catch {
    /* a read-only state directory must not fail linking or unlinking */
  }
}

/** Where an installed DSH keeps its own dependencies. */
function harnessRoots() {
  const roots = namedRoots();
  const add = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) roots.push(resolve(value.trim()));
  };
  // npm global install
  add(join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh'));
  // No packaged-desktop path is probed, deliberately. The app's own packages live in
  // `resources/app.asar`, which plain Node cannot stat at all (only Electron can), and its
  // `app.asar.unpacked` twin ships native packages only — not the harness. So on a
  // desktop-only machine there is nothing here to resolve: name the runtime explicitly with
  // DSH_RUNTIME_ROOT (an extracted copy), or use the npm CLI install. The provider itself
  // needs neither, because it resolves the base class through `process.resourcesPath` first.
  return roots;
}

/** @returns {string|null} the real directory backing `name` in some harness root */
function locate(name) {
  const parts = name.split('/');
  for (const root of harnessRoots()) {
    const candidates = [join(root, ...parts), join(root, 'node_modules', ...parts)];
    // `DSH_RUNTIME_ROOT` usually IS a package inside `node_modules/@deepseek-ai`, so its
    // siblings — exactly the packages wanted here — sit one level up under the scope dir.
    const scope = dirname(root);
    if (parts[0].startsWith('@') && basename(scope) === parts[0]) candidates.push(join(scope, parts[1]));
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'package.json'))) return realpathSafe(candidate) ?? candidate;
    }
    try {
      return dirname(createRequire(join(root, 'package.json'))(`${name}/package.json`));
    } catch {
      /* try the next root */
    }
  }
  return null;
}

const args = process.argv.slice(2);
const mode = args.find((a) => a === '--remove' || a === '--check') ?? null;
const has = (flag) => args.includes(flag);

/**
 * Where the junctions go. `--shared` is the desktop install layout; the default is this
 * checkout, which is what the tests load.
 */
function destination() {
  if (has('--dest')) {
    const value = args[args.indexOf('--dest') + 1];
    if (!value) throw new Error('--dest needs a node_modules directory');
    return resolve(value);
  }
  if (has('--shared')) {
    return join(resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh')), 'profiles', 'node_modules');
  }
  return join(pluginRoot, 'node_modules');
}

const nodeModules = destination();
// Refusing to flip an existing link is only right about a directory we do not own.
// `pluginRoot/node_modules` was created by this tool and is ours to re-aim; `--shared` is
// every profile's ancestor and may have been pointed somewhere deliberately.
const ownsDestination = resolve(nodeModules) === join(pluginRoot, 'node_modules');
const ledger = readLedger();
let ledgerDirty = false;
let unresolved = 0;
let keptForeign = 0;
const conflicts = [];

for (const name of WANTED) {
  const link = join(nodeModules, ...name.split('/'));
  const target = locate(name);

  if (mode === '--remove') {
    if (!lstatSafe(link)) {
      console.log(`= ${name} not linked`);
      continue;
    }
    const raw = readlinkSafe(link);
    if (raw === null) {
      console.log(`! ${name}: ${link} is not a link, left untouched`);
      continue;
    }
    // Ownership, not link-ness, and not "it points where I would point": on a shared
    // `profiles/node_modules` the harness's own junctions look exactly like ours. See
    // tools/link-ownership.mjs.
    const key = canonicalPath(link);
    const reason = has('--force')
      ? null
      : foreignLinkReason({
          link,
          current: realpathSafe(link),
          raw,
          ownsDestination,
          recorded: ledger[key] ?? null,
        });
    if (reason !== null) {
      console.log(`! ${name}: 未改动 ${link}\n    ${reason}（未证明是本工具建的；确要删除加 --force）`);
      keptForeign += 1;
      continue;
    }
    rmSync(link, { recursive: true, force: true });
    if (key in ledger) {
      delete ledger[key];
      ledgerDirty = true;
    }
    console.log(`- removed ${link}`);
    continue;
  }

  if (target === null) {
    console.error(`✗ ${name}: not found in any harness root — set DSH_RUNTIME_ROOT`);
    unresolved += 1;
    continue;
  }

  // A junction in a directory other profiles share must never displace a real install
  // that another plugin may already be resolving. Ours we may replace; anything else
  // is left exactly as found.
  const isLink = readlinkSafe(link) !== null && lstatSafe(link);
  if (lstatSafe(link) && !isLink) {
    console.log(`! ${name}: ${link} is a real directory, left untouched`);
    continue;
  }

  const current = isLink ? realpathSafe(link) : null;
  if (mode === '--check') {
    const ok = current === target;
    console.log(`${ok ? '✓' : '✗'} ${name}\n    link   : ${link}${current ? ` → ${current}` : ' (absent)'}\n    target : ${target}`);
    if (!ok) unresolved += 1;
    continue;
  }

  if (current === target) {
    console.log(`= ${name} already linked`);
    continue;
  }
  // An existing link aimed at another install is not ours to flip. `profiles/node_modules`
  // is shared by EVERY profile, so on a machine that also has the npm CLI, silently
  // retargeting it moves the ground under that runtime too. Creating what is absent is
  // safe; replacing something someone chose is not.
  if (current !== null && !ownsDestination && !has('--force')) {
    conflicts.push({ name, current, target });
    continue;
  }
  if (current !== null) rmSync(link, { recursive: true, force: true });
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, 'junction');
  // Record authorship here and nowhere else: an existing link that already pointed at the
  // right runtime is reported `already linked` above and deliberately not claimed, so a
  // later `--remove` cannot delete something this tool did not create.
  ledger[canonicalPath(link)] = { target: canonicalPath(target), at: new Date().toISOString() };
  ledgerDirty = true;
  console.log(`✓ ${name}\n    ${link}\n    → ${target}`);
}

if (ledgerDirty) writeLedger(ledger);

if (conflicts.length > 0) {
  console.log(`\n${conflicts.length} 个链接已指向另一套 harness，本工具**没有改动它们**（这是所有 profile 共享的目录）：`);
  for (const c of conflicts) console.log(`  ${c.name}\n    现在: ${c.current}\n    本套: ${c.target}`);
  console.log('不改也能跑：provider 优先用 process.resourcesPath 解析 app 自带的那份；只有那条失败才会落到这个共享目录。');
  console.log('确要改指本机这套 runtime（会影响其它 profile / 另一套 CLI）：加 --force，改前 guard snapshot，用 --remove 还原。');
}

if (mode === '--remove') {
  // Prune the scope directory and the node_modules we created, but only once empty: a
  // shared `profiles/node_modules` may hold other packages, which stay untouched.
  for (const dir of [join(nodeModules, ...WANTED[0].split('/').slice(0, 1)), nodeModules]) {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
  console.log('junctions removed; targets untouched');
  if (keptForeign > 0) {
    console.log(
      `另有 ${keptForeign} 个同名链接没有归属证据（不是本工具建的，或被改指过），未改动。\n` +
        '  它们可能属于 harness 或另一套安装，删掉会破坏其它 profile；确要删除：加 --force。',
    );
  }
} else if (unresolved > 0) {
  console.error(`\n${unresolved} package(s) unresolved — the provider cannot bind its base class.`);
  if (mode === '--check') console.error('run: node tools/link-deps.mjs');
  process.exitCode = 1;
} else {
  console.log(`目标目录: ${nodeModules}`);
}
