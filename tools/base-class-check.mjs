/**
 * The post-install self-check behind `tools/install.mjs`.
 *
 * It answers one question: which harness copy does the file we just installed really
 * resolve its base class from? Node resolves bare specifiers from the module's REAL path,
 * so a `link:` install answers with the checkout's tree while a directory install answers
 * with the profile bridge — and a mismatch is the double-copy bug, where the provider
 * mounts and reports success while subclassing a class the running harness does not
 * recognise.
 *
 * Kept out of the script so both halves are testable without running an install, and so
 * two facts stay pinned:
 *   - `require.resolve()` returns a PATH. Wrapping it in `fileURLToPath()` throws
 *     `ERR_INVALID_URL_SCHEME` on Windows and `ERR_INVALID_URL` elsewhere, which silently
 *     turned the check into a permanent "cannot resolve the base class" failure with exit
 *     code 1 — on installs that had in fact succeeded.
 *   - `import.meta.resolve(specifier, parent)` ignores `parent`, so asking it "what would
 *     the installed file see?" answers "what would THIS file see". `createRequire(base)`
 *     honours its base, which is what `lib/compaction.js` uses too.
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/**
 * @param {string} entry absolute path to the installed `lib/compaction.js`
 * @param {string} spec bare package name to resolve, e.g. `@deepseek-ai/dsh-compaction-basic`
 * @returns {string|null} the resolved file path, or null when it cannot be resolved
 */
export function resolveInstalledBase(entry, spec) {
  try {
    return createRequire(realpathSync(entry)).resolve(spec);
  } catch {
    return null;
  }
}

/**
 * Compare where the installed copy resolves its base class with the runtime the caller
 * named. A missing name is not a comparison, and saying "✓" for one was the second half of
 * the same false positive.
 *
 * @param {string} found a path from {@link resolveInstalledBase}
 * @param {string|undefined} runtimeRoot the `DSH_RUNTIME_ROOT` the caller was given
 * @returns {{status: 'unset'|'unresolvable'|'same'|'different', scope?: string, dir?: string, runtime?: string}}
 */
export function compareWithRuntime(found, runtimeRoot) {
  const named = typeof runtimeRoot === 'string' ? runtimeRoot.trim() : '';
  if (named.length === 0) return { status: 'unset' };
  let scope;
  let dir;
  try {
    // `DSH_RUNTIME_ROOT` names the `@deepseek-ai/dsh` package, so its `@deepseek-ai` parent
    // is the scope every harness package of that runtime sits under.
    scope = realpathSync(resolve(named, '..'));
    dir = realpathSync(dirname(found));
  } catch {
    return { status: 'unresolvable', runtime: named };
  }
  return dir.startsWith(scope) ? { status: 'same', scope, dir } : { status: 'different', scope, dir };
}
