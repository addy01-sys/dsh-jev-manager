/**
 * Resolve harness packages from the module tree the CURRENT PROCESS is running, not from
 * wherever this plugin happens to sit.
 *
 * Why bare specifiers are not enough: a plugin installed under
 * `$DSH_HOME/profiles/<p>/node_modules/…` resolves `@deepseek-ai/*` by walking UP to
 * `$DSH_HOME/profiles/node_modules`, a directory EVERY profile shares and whichever
 * runtime last installed a plugin populates. On a machine with both the npm CLI and the
 * desktop app, that is the CLI's copy — so the app would silently load a different
 * `BasicCompactionEngine` than the one it is running.
 *
 * Two facts this encodes, both measured on a real install:
 *   - `import.meta.resolve(specifier, parentURL)` IGNORES its second argument in Node;
 *     asking "what would that file see?" answers "what does THIS file see", while looking
 *     correct in a log. `createRequire(base)` does honor its base, so that is what we use.
 *   - The desktop app's own packages live in `resources/app.asar`, unreachable to plain
 *     Node but resolvable from inside Electron, which sets `process.resourcesPath`.
 *
 * Nothing here imports a harness package: every result comes back by name and path, and
 * callers degrade when a lookup fails.
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Anchors to try, best-first, as plain paths.
 * @param {object} ctx
 * @returns {string[]}
 */
export function resolutionAnchors(ctx) {
  const anchors = [];
  const resources = process.resourcesPath;
  if (typeof resources === 'string' && resources.length > 0) {
    // `desktop-runtime.json` in the app lists its sharedPackages under `dsh/`, so that is
    // where the running harness's own copies sit; the asar root is the fallback.
    const asar = join(resources, 'app.asar');
    anchors.push(join(asar, 'dsh', 'package.json'), join(asar, 'package.json'));
  }
  try {
    const profileContext = ctx?.get?.('profileContext');
    for (const candidate of [profileContext?.installAnchor, profileContext?.dir]) {
      if (typeof candidate === 'string' && candidate.length > 0) anchors.push(candidate);
    }
  } catch {
    /* profileContext is a host-plane service; a bare harness has none */
  }
  // This plugin's own tree: the npm CLI layout, where the harness and the plugin are one install.
  anchors.push(dirname(dirname(fileURLToPath(import.meta.url))));
  return anchors;
}

/**
 * @param {string} specifier bare package name
 * @param {string} base a file or directory path
 * @returns {Promise<{mod: object, resolved: string}|null>} resolved as a file: URL
 */
async function resolveFrom(specifier, base) {
  try {
    // createRequire wants a file; only its directory is used, so hang the base off a name.
    const req = createRequire(base.includes('.') ? base : join(base, 'noop.js'));
    const resolvedFile = req.resolve(specifier);
    const url = pathToFileURL(resolvedFile).href;
    return { mod: await import(url), resolved: url };
  } catch {
    return null;
  }
}

/**
 * @param {object|null} ctx cordis context, when one is available
 * @param {string} specifier
 * @param {(mod: object) => unknown} pick
 * @returns {Promise<{value: any, resolved: string, from: string}|null>}
 */
export async function loadFromAnchors(ctx, specifier, pick) {
  for (const base of resolutionAnchors(ctx)) {
    const hit = await resolveFrom(specifier, base);
    const value = hit === null ? null : pick(hit.mod);
    if (value !== null && value !== undefined) return { value, resolved: hit.resolved, from: base };
  }
  return null;
}

/**
 * Did we end up binding a copy from OUTSIDE the app that is running this?
 * @param {string} resolved file: URL
 * @returns {string|null} a reason to refuse, or null when the binding is sound
 */
export function foreignHarnessReason(resolved) {
  const resources = process.resourcesPath;
  if (typeof resources !== 'string' || resources.length === 0) return null;
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const target = norm(fileURLToPath(resolved));
  // Compare what the paths ARE, not how they are spelled: resolution goes through reparse
  // points, so one file can appear as app.asar/… or as its unpacked twin.
  for (const candidate of [join(resources, 'app.asar'), join(resources, 'app.asar.unpacked')]) {
    let real = null;
    try {
      real = realpathSync(candidate);
    } catch {
      /* the archive is not a directory plain Node can stat */
    }
    for (const form of [candidate, real]) {
      if (form !== null && form !== undefined && target.startsWith(norm(form))) return null;
    }
  }
  return `运行在桌面 app 内，但解析到的包不在 app.asar 里：${target}`;
}
