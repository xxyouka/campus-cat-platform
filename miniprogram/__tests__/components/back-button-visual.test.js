/**
 * 返回键视觉口径的反向契约（2026-10-11）
 *
 * 用户实测反馈：「每个页面的返回键有点丑，感觉太长了」。
 * 定位到的原因是三层叠加：描边胶囊 + 毛玻璃底 + 「返回」文字，
 * 左区因此比系统返回键宽了近一倍。
 *
 * 改成「只画箭头 + 隐形热区」。这里把结论钉住，防止后人「顺手优化」时
 * 把描边、底色或文字又加回来 —— 那正是它当初变成这样的原因（没人反对，
 * 只是一层层往上加）。
 *
 * 为什么对两份实现都立契约：返回键在仓库里有**两份**彼此独立的实现，
 * 只改一处就会出现「有的页面变了、有的没变」的割裂感：
 *   1. components/custom-navbar/custom-navbar.wxss  ← 绝大多数页面
 *   2. styles/utilities.wxss                       ← 全局工具类
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const IMPLS = [
  'components/custom-navbar/custom-navbar.wxss',
  'styles/utilities.wxss',];

/** 取出某个选择器的完整声明体（只认顶层块，避免误吃嵌套规则） */
function ruleBody(css, selector) {
  const re = new RegExp(`(^|[},])\\s*${selector.replace('.', '\\.')}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  return m ? m[3] : null;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('返回键视觉契约（箭头 + 隐形热区）', () => {
  describe.each(IMPLS)('%s', (rel) => {
    const css = read(rel);

    test('.back-btn 存在', () => {
      expect(ruleBody(css, '.back-btn')).not.toBeNull();
    });

    // 触感底线：热区不能因为「变好看」而缩水。约 60rpx 时返回键曾频繁误触，
    // 那是个真实修过的 bug —— 视觉可以瘦，手指不能。
    test('.back-btn 保留 88rpx(44px) 热区', () => {
      const body = ruleBody(css, '.back-btn');
      expect(body).toMatch(/width:\s*88rpx/);
      expect(body).toMatch(/height:\s*88rpx/);
    });

    test('.back-btn 不再画胶囊（无描边、无底色、无毛玻璃）', () => {
      const body = ruleBody(css, '.back-btn');
      expect(body).toMatch(/background:\s*transparent/);
      expect(body).not.toMatch(/backdrop-filter/);
      // 只允许 border-radius，不允许 border（描边正是胶囊感的来源）
      expect(body).not.toMatch(/(^|[;\s])border(-(top|right|bottom|left))?\s*:/);
    });

    test('.back-btn 不用 padding 把热区撑大（宽高已直接给定）', () => {
      expect(ruleBody(css, '.back-btn')).not.toMatch(/padding\s*:/);
    });

    test('.back-arrow 存在且是 currentcolor（各主题只改 color，不重复描边色）', () => {
      const arrowSel = css.includes('.back-arrow-icon') ? '.back-arrow-icon' : '.back-arrow';
      const body = ruleBody(css, arrowSel);
      expect(body).not.toBeNull();
      expect(body).toMatch(/currentcolor/);
    });
  });

  describe('自定义导航栏组件', () => {
    test('各主题不再给 .back-btn 单独上底色（否则胶囊会复活）', () => {
      const css = read('components/custom-navbar/custom-navbar.wxss');
      // 曾存在 .navbar.default/.light .back-btn { background: ... } 这类覆盖，
      // 它们会把底色重新加回来，而主样式已经改成 transparent。
      expect(css).not.toMatch(/\.navbar\.[a-z]+\s+\.back-btn\s*\{[^}]*background/);
      expect(css).not.toMatch(/@media[^{]*\{[\s\S]*?\.back-btn\s*\{[^}]*background/);
    });

    test('hover 反馈只做缩放（任何主题下都成立）', () => {
      const body = ruleBody(read('components/custom-navbar/custom-navbar.wxss'), '.back-btn-hover');
      expect(body).toMatch(/transform:\s*scale/);
      expect(body).not.toMatch(/background/);
    });
  });

  describe('模板层', () => {
    test('组件模板的返回文字受 showBackText 控制（默认关）', () => {
      const wxml = read('components/custom-navbar/custom-navbar.wxml');
      expect(wxml).toContain('wx:if="{{showBackText}}"');
    });

    test('返回键有 aria-label（去掉文字后只剩图形，无障碍名称不能一起没）', () => {
      expect(read('components/custom-navbar/custom-navbar.wxml')).toContain('aria-label="返回上一页"');
    });
  });
});