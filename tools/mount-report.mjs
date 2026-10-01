/**
 * Read back how the compaction row came up.
 *
 * The desktop app gives you no console and no log file you can point a plugin at, so the
 * provider writes its own one-shot record into the plugin's state directory. This is how
 * you answer the three questions that actually decide whether the feature is live:
 * which BasicCompactionEngine did we bind, is it the running harness's, and does this
 * realm serve the credentials seam at all.
 *
 *   node tools/mount-report.mjs
 *   node tools/mount-report.mjs --json
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { readMountRecord, stateDir, readFeatures } = await import(new URL('../lib/features.mjs', import.meta.url).href);

const record = readMountRecord();
if (record === null) {
  console.log(`没有挂载记录：${join(stateDir(), "mount.json")}`);
  console.log('说明压缩 provider 那一行从未运行过——preset 层没生效，或会话没选「Jev 上下文整理」预设。');
  console.log('host 平面不受影响：', JSON.stringify(readFeatures()));
  process.exit(1);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}

console.log(`时间     : ${record.at}`);
console.log(`挂载     : ${record.mounted ? '是' : '否 — ' + record.reason}`);
if (!record.mounted) {
  console.log(`试过的锚点: ${(record.anchors ?? []).join('\n            ') || '（无）'}`);
  process.exit(1);
}
// `base` is a resolved module URL; a Windows drive path is what you can actually compare
// against the app's own tree, and fileURLToPath is the only correct way to get it.
const asPath = (u) => {
  try {
    return u?.startsWith('file:') ? fileURLToPath(u) : u;
  } catch {
    return u;
  }
};
console.log(`基类     : ${record.base_class}  ←  ${asPath(record.base)}`);
console.log(`锚点     : ${asPath(record.anchor)}`);
console.log(`schemastery: ${record.schemastery ? '已解析（配置有校验）' : '未解析（用默认调参运行）'}`);
console.log(`credentials: ${record.credentials_seam ? '本 realm 可解析（能取到 key）' : '本 realm 取不到 → 只会用启动环境变量里的 TYPESAFE_API_KEY'}`);
console.log(`模式     : ${record.adopt ? 'ACTIVE（可替换 DSH 摘要）' : 'SHADOW（只记录，仍用 DSH 摘要）'}`);
console.log(`provider 开关: ${record.provider_feature ? 'on' : 'off'}`);
console.log('\n基类路径里出现 app.asar = 绑的是 app 自带那份；出现 profiles/node_modules = 绑的是共享目录里的旧副本。');
