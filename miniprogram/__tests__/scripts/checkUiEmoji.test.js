/**
 * __tests__/scripts/checkUiEmoji.test.js
 *
 * 图标门禁（scripts/check-ui-emoji.js）的自测。
 *
 * 为什么门禁自己也要有测试：2026-10-11 连续两次出现「在注释里解释为什么不能用某个
 * emoji 字符 → 该字符本身把门禁打红」。于是给扫描加了注释豁免 —— 而豁免本身是
 * 一条「让门禁变松」的改动：万一剥注释的逻辑写错（比如把可见文本里的字符也剥掉），
 * 门禁会静悄悄地失去检测能力，且不会有任何其他测试发现。
 *
 * 所以这里同时锁两端：
 *   ① 可见文本里的 emoji 必须仍然被报出来（豁免不能漏）；
 *   ② 注释里的 emoji 不再被报（这正是豁免的目的）。
 */
const { EMOJI_RE, stripComments, checkEmoji, problems } = require('../../scripts/check-ui-emoji');

const EMOJI = '\u{1F600}';          // 😀
const PICTO = '\u00A9';            // 版权符号（Unicode 15+ 属 Extended_Pictographic）
const BELL = '\u26A0\uFE0F';       // ⚠️（含变体选择符）

function scan(text) {
  problems.length = 0;
  checkEmoji('probe.txt', text);
  return problems.slice();
}

afterEach(() => { problems.length = 0; });

describe('check-ui-emoji · 注释豁免', () => {
  test('可见文本里的 emoji 仍然被报出（豁免不得漏检）', () => {
    expect(scan(`<text class="tip">${EMOJI} 快来</text>`)).toHaveLength(1);
  });

  test('可见文本里的版权符号仍然被报出', () => {
    expect(scan(`<text>${PICTO} 2026 某某公司</text>`)).toHaveLength(1);
  });

  test('JS 行注释里的 emoji 不再被报出', () => {
    expect(scan(`// 这里说明为什么不能用 ${EMOJI}\nconst a = 1;`)).toHaveLength(0);
  });

  test('JS 块注释（含跨行）里的 emoji 不再被报出', () => {
    const src = [
      '/**',
      ` * 历史遗留：${BELL} 曾经写在标题里，已改用图标组件。`,
      ' */',
      'const a = 1;'
    ].join('\n');
    expect(scan(src)).toHaveLength(0);
  });

  test('wxml / md 的 <!-- --> 注释（含跨行）里的 emoji 不再被报出', () => {
    const src = [
      '<!-- 口径说明：',
      `     U+00A9（${PICTO}）属于 Extended_Pictographic，会被门禁拦下，`,
      '     因此页脚改用文字表述。',
      '     -->',
      '<view class="footer">版权所有</view>'
    ].join('\n');
    expect(scan(src)).toHaveLength(0);
  });

  test('同一文件里注释豁免、可��文本照报（行号不错位）', () => {
    const src = [
      `<!-- 注释里的 ${EMOJI} 不算 -->`,
      '<view>正常内容</view>',
      `<view>${EMOJI} 这个要报</view>`
    ].join('\n');
    const found = scan(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(':3');
  });

  test('剥注释不改变行数（保证报错行号仍指向原文）', () => {
    const src = ['/* a */', '// b', '<view>c</view>'].join('\n');
    expect(stripComments(src).split(/\r?\n/)).toHaveLength(3);
  });

  test('emoji 正则本身仍然覆盖三类真实踩过的字符', () => {
    expect(EMOJI_RE.test(EMOJI)).toBe(true);
    expect(EMOJI_RE.test(PICTO)).toBe(true);
    expect(EMOJI_RE.test(BELL)).toBe(true);
  });
});