/**
 * Human-side feature switches, so the model-facing `jev_features` tool is not the
 * only way to drive this plugin.
 *
 * Neither path writes DSH's configuration: state lives under `~/.dsh/jev-manager/`.
 *
 *   node tools/features.mjs                      # show state
 *   node tools/features.mjs enable decision
 *   node tools/features.mjs disable review
 *   node tools/features.mjs off                  # every switch off at once
 */

import { existsSync } from 'node:fs';
import { FEATURES, featuresPath, readFeatures, renderFeatures, writeFeatures } from '../lib/features.mjs';

const names = Object.keys(FEATURES);
const [command, target] = process.argv.slice(2);

if (command === undefined || command === 'list' || command === 'status') {
  const enabled = readFeatures();
  console.log(renderFeatures(names.filter((name) => enabled[name] === true)));
  console.log(`\n状态文件: ${featuresPath()}${existsSync(featuresPath()) ? '' : '   （尚未创建 = 全新安装，全关）'}`);
  console.log(`当前注册的额外工具: ${names.filter((name) => enabled[name]).flatMap((name) => FEATURES[name].tools).join(', ') || '无'}`);
} else if (command === 'enable' || command === 'disable') {
  if (!names.includes(target)) {
    console.error(`未知功能: ${target ?? '(未指定)'}   可选: ${names.join(' | ')}`);
    process.exitCode = 1;
  } else {
    writeFeatures({ [target]: command === 'enable' });
    console.log(`${command === 'enable' ? '已开启' : '已关闭'} ${target} — ${FEATURES[target].label}`);
    console.log(`涉及工具: ${FEATURES[target].tools.join(', ') || '（无）'}`);
    if (target === 'provider' && command === 'enable') {
      console.log('\n提醒：这只记录了运行时意图。ctx.compaction 的后端要由装配层挂载才真的生效：');
      console.log('  CLI:  dsh --profile <p> --patch ./jev-preset.patch.yml      ← 不写你的配置文件');
      console.log('  桌面: 把 jev-preset.patch.yml 的内容并进 ~/.dsh/profiles/<p>/cordis.patch.yml');
      console.log('        （app 不给传 --patch；这会让 guard compare 报这一层动过，装前先 snapshot）');
      console.log('  0.1.5: node tools/install-preset.mjs                        ← 目录式 preset，会动文件');
    }
    console.log('\n运行中的会话调用一次 jev_features { action: "list" } 即重新同步注册；否则重启会话。');
  }
} else if (command === 'off') {
  writeFeatures(Object.fromEntries(names.map((name) => [name, false])));
  console.log('全部功能已关闭。会话里再调一次 jev_features { action: "list" } 会注销所有工具。');
} else {
  console.log('用法: node tools/features.mjs [list|enable <feature>|disable <feature>|off]');
  console.log(`功能: ${names.join(' | ')}`);
  process.exitCode = 1;
}
