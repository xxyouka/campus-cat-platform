#!/usr/bin/env node
/**
 * scripts/check-guidance.js —— 引导配置门禁
 *
 * 背景：引导配置是「字符串指向页面与 WXML id」。改页面时删了 id、写错路径，
 * 运行时只会静默不显示（用户看不到，开发也不知道）。这个脚本把这类腐烂
 * 提前到 CI：
 *
 *   1. releases[].items[].entry 必须是 app.json 里真实存在的页面；
 *   2. tours[].page 必须存在，每个 step.selector 必须是该页 WXML 里真实的 id；
 *   3. 除隐私政策外，每个用户页面都必须有导览（「所有功能都有引导」的门禁）；
 *   4. id 唯一、版本号格式正确、文案非空、feature/placement 合法。
 *
 * 用法：node scripts/check-guidance.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const config = require(path.join(ROOT, 'config.js'));

const mainPages = appJson.pages || [];
const pages = new Set(mainPages);
for (const sub of appJson.subpackages || []) {
  for (const page of sub.pages || []) {
    pages.add(`${sub.root}/${page}`);
  }
}

// 隐私政策是法律文本；帮助页自身不列入功能入口。
const ENTRY_EXEMPT_PAGES = new Set(['pages/privacy/privacy', 'pages/help/help']);

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pageFile(page) {
  return path.join(ROOT, `${page}.wxml`);
}

function pageHasId(page, id) {
  const file = pageFile(page);
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, 'utf8');
  return new RegExp(`id\\s*=\\s*["']${escapeRegExp(id)}["']`).test(content);
}

function normalizeEntry(entry) {
  return String(entry).split('?')[0].replace(/^\//, '');
}

function checkRelease(release, index, seenIds) {
  const label = `releases[${index}]`;
  if (!release || typeof release !== 'object') {
    fail(`${label} 不是对象`);
    return;
  }

  if (!release.id || typeof release.id !== 'string') {
    fail(`${label}.id 缺失`);
  } else if (seenIds.has(release.id)) {
    fail(`${label}.id 重复：${release.id}`);
  } else {
    seenIds.add(release.id);
  }

  if (!/^\d+\.\d+\.\d+$/.test(release.version || '')) {
    fail(`${label}.version 必须是 x.y.z，当前为 ${release.version}`);
  }
  if (!release.title) fail(`${label}.title 缺失`);
  if (!Array.isArray(release.items) || release.items.length === 0) {
    fail(`${label}.items 不能为空`);
    return;
  }

  release.items.forEach((item, itemIndex) => {
    const itemLabel = `${label}.items[${itemIndex}]`;
    if (!item || !item.text) fail(`${itemLabel}.text 缺失`);
    if (item && item.entry) {
      const page = normalizeEntry(item.entry);
      if (!pages.has(page)) {
        fail(`${itemLabel}.entry 指向不存在的页面：${item.entry}`);
      }
    }
  });
}

function checkStep(step, tour, stepIndex, seenStepIds, tourPage) {
  const label = `tours[${tour.id}].steps[${stepIndex}]`;
  if (!step || typeof step !== 'object') {
    fail(`${label} 不是对象`);
    return;
  }

  if (!step.id || typeof step.id !== 'string') {
    fail(`${label}.id 缺失`);
  } else if (seenStepIds.has(step.id)) {
    fail(`${label}.id 在同一导览内重复：${step.id}`);
  } else {
    seenStepIds.add(step.id);
  }

  if (!step.title) fail(`${label}.title 缺失`);
  if (!step.desc) fail(`${label}.desc 缺失`);

  const selector = step.selector || '';
  if (!selector.startsWith('#')) {
    fail(`${label}.selector 只支持 id（#xxx），当前为 ${selector || '(空)'}`);
    return;
  }
  if (!pageHasId(tourPage, selector.slice(1))) {
    fail(`${label}.selector 在 ${tourPage}.wxml 里找不到：${selector}`);
  }

  if (step.feature !== undefined && typeof step.feature !== 'string') {
    fail(`${label}.feature 必须是字符串开关名`);
  }
  if (step.optional !== undefined && typeof step.optional !== 'boolean') {
    fail(`${label}.optional 必须是布尔值`);
  }
  if (step.placement && !['auto', 'above', 'below'].includes(step.placement)) {
    fail(`${label}.placement 只能是 auto / above / below，当前为 ${step.placement}`);
  }
  if (step.presentation && !['coach', 'card'].includes(step.presentation)) {
    fail(`${label}.presentation 只能是 coach / card，当前为 ${step.presentation}`);
  }
}

function checkTour(tour, index, seenIds) {
  const label = `tours[${index}]`;
  if (!tour || typeof tour !== 'object') {
    fail(`${label} 不是对象`);
    return;
  }

  if (!tour.id || typeof tour.id !== 'string') {
    fail(`${label}.id 缺失`);
  } else if (seenIds.has(tour.id)) {
    fail(`${label}.id 重复：${tour.id}`);
  } else {
    seenIds.add(tour.id);
  }

  if (!tour.page) {
    fail(`${label}.page 缺失`);
  } else if (!pages.has(tour.page)) {
    fail(`${label}.page 不存在于 app.json：${tour.page}`);
  }

  if (!tour.label) fail(`${label}.label 缺失`);
  if (!tour.desc) fail(`${label}.desc 缺失`);
  if (tour.feature !== undefined && typeof tour.feature !== 'string') {
    fail(`${label}.feature 必须是字符串开关名`);
  }
  if (tour.replayable !== undefined && typeof tour.replayable !== 'boolean') {
    fail(`${label}.replayable 必须是布尔值`);
  }
  if (tour.presentation && !['coach', 'card'].includes(tour.presentation)) {
    fail(`${label}.presentation 只能是 coach / card，当前为 ${tour.presentation}`);
  }
  if (!Array.isArray(tour.steps) || tour.steps.length === 0) {
    fail(`${label}.steps 不能为空`);
    return;
  }

  const stepIds = new Set();
  tour.steps.forEach((step, stepIndex) => checkStep(step, tour, stepIndex, stepIds, tour.page));
}

function checkEntryCoverage(tours) {
  const covered = new Set(tours.map(tour => tour && tour.page).filter(Boolean));
  mainPages.forEach(page => {
    if (ENTRY_EXEMPT_PAGES.has(page)) return;
    if (!covered.has(page)) {
      fail(`页面缺少功能入口：${page}（除隐私政策和帮助页外，每个主包页面都要能在「使用帮助 → 功能入口」里找到）`);
    }
  });
}

function main() {
  const guidance = config.guidance;
  if (!guidance || typeof guidance !== 'object') {
    fail('config.guidance 缺失');
  } else {
    const campaign = guidance.campaign;
    if (guidance.enabled !== undefined && typeof guidance.enabled !== 'boolean') {
      fail('guidance.enabled 必须是布尔值');
    }
    if (!campaign || !campaign.id) {
      fail('guidance.campaign.id 缺失：无法区分每轮全量引导');
    } else if (!/^\d+\.\d+\.\d+$/.test(campaign.version || '')) {
      fail(`guidance.campaign.version 必须是 x.y.z，当前为 ${campaign.version}`);
    }

    const releaseIds = new Set();
    (guidance.releases || []).forEach((release, index) => checkRelease(release, index, releaseIds));

    const tours = Array.isArray(guidance.tours) ? guidance.tours : [];
    const tourIds = new Set();
    tours.forEach((tour, index) => checkTour(tour, index, tourIds));

    checkEntryCoverage(tours);

    if (guidance.enabled === false) {
      warn('guidance.enabled=false：页面内分步导览已停用；功能入口仍按 tours 校验');
    }

    if ((guidance.releases || []).length === 0) warn('releases 为空：新版本更新卡不会出现');
    if (tours.length === 0) warn('tours 为空：没有任何全功能导览');

    console.log(`[guidance] campaign: ${campaign && campaign.id || '(none)'}, releases: ${(guidance.releases || []).length}, tours: ${tours.length}`);
  }

  warnings.forEach(message => console.warn(`[guidance] warn: ${message}`));

  if (errors.length) {
    errors.forEach(message => console.error(`[guidance] error: ${message}`));
    console.error(`\n[guidance] 失败：${errors.length} 项。修 config/guidance.js 或对应 WXML 的 id 后重跑。`);
    process.exit(1);
  }

  console.log('[guidance] ✓ 引导配置与页面一致');
}

main();
