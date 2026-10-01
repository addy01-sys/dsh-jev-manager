/**
 * Ownership rule for the junctions `link-deps.mjs` creates — and therefore for the ones
 * `--remove` is allowed to delete.
 *
 * "It is a link" is not evidence of ownership, and neither is "it points at the runtime I
 * would pick now": `$DSH_HOME/profiles/node_modules` is shared by every profile, the
 * harness fills it with its own junctions to its own runtime, and with `DSH_RUNTIME_ROOT`
 * unset that runtime is *the same npm install* this tool would choose. Measured on this
 * machine: 249 harness junctions, three of them with exactly the names this tool wants —
 * a target comparison deletes all three. `tools/guard.mjs` skips that directory, so nothing
 * else would notice.
 *
 * So ownership is authorship, not resemblance:
 *
 *   - the destination is the checkout's own `node_modules`, which only this tool writes;
 *   - the link is in this plugin's ledger, recorded when this tool created it, and still
 *     points where it was recorded to point (a re-pointed link is somebody's choice);
 *   - the link dangles and points into the desktop app's `app.asar`, which plain Node cannot
 *     stat at all: nothing but this plugin's desktop bridge puts a junction in there.
 *
 * Anything else is reported and left alone; `--force` is the escape hatch. The rule lives
 * apart from the script so it is testable without running the CLI, and so the ledger format
 * has one home.
 */

import { dirname, isAbsolute, resolve } from 'node:path';

/** Windows junctions can come back from `readlink` with this prefix; comparisons want it gone. */
const stripPrefix = (path) => path.replace(/^\\\\\?\\/, '');

/**
 * One spelling per path: no `\\?\` prefix, no trailing separator, forward slashes only,
 * lower case. Windows differs in case between a realpath and a resolver's answer, and the
 * ledger is keyed by this string, so a missed match means refusing to delete our own link.
 */
export function canonicalPath(path) {
  return stripPrefix(String(path)).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

const samePath = (left, right) => canonicalPath(left) === canonicalPath(right);

/** The path a link points at, whether or not it resolves. */
export function linkTargetPath(link, raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return stripPrefix(isAbsolute(raw) ? resolve(raw) : resolve(dirname(link), raw));
}

/** Is `child` inside (or equal to) `root`? */
function contained(child, root) {
  const a = canonicalPath(child);
  const b = canonicalPath(root);
  return a === b || a.startsWith(`${b}/`);
}

/**
 * @param {{link: string, current: string|null, raw: string|null, ownsDestination: boolean,
 *          recorded?: {target?: string}|null}} input
 *   `current` is the link's realpath (null when it dangles), `raw` its readlink result,
 *   `ownsDestination` whether the whole destination directory belongs to this checkout, and
 *   `recorded` this plugin's ledger entry for the link, when there is one.
 * @returns {string|null} null when the link is this tool's to delete, otherwise the reason
 *   it is not — for a human reading `--remove` output.
 */
export function foreignLinkReason({ link, current, raw, ownsDestination, recorded = null }) {
  if (ownsDestination) return null;

  const pointsAt = linkTargetPath(link, current ?? raw);
  if (recorded !== null && typeof recorded?.target === 'string') {
    if (pointsAt !== null && samePath(pointsAt, recorded.target)) return null;
    return `本工具的记录里它指向 ${recorded.target}，现在却指向 ${pointsAt ?? '(未知)'}`;
  }

  // A target inside the app's archive: unreachable to plain Node, so the link always reads
  // as dangling here — and the harness's own junction batch never points into an archive.
  if (current === null && typeof raw === 'string' && /(^|[\\/])app\.asar([\\/]|$)/i.test(stripPrefix(raw))) {
    return null;
  }

  if (current !== null) return `它指向 ${current}`;
  const rawPath = linkTargetPath(link, raw);
  return rawPath === null ? '读不到它的链接目标' : `它指向已经不存在的 ${rawPath}`;
}
