/**
 * __tests__/cloudfunctions/healthStatus.enum.test.js
 *
 * 回归：猫咪健康状态的前后端枚举必须一致。
 *
 * 背景：后端 `CAT_VALID_HEALTH_STATUS` 原为
 *   ['healthy', 'unhealthy', 'recovering', 'unknown']
 * 而前端录入页（add-cat / edit-cat）的 data-value 选项是
 *   healthy / stomatitis / skin / other
 * 两套值**毫无交集**——前端从未使用过 unhealthy / recovering / unknown，
 * 而 stomatitis / skin / other 又被后端判为非法。
 *
 * 后果：管理员在「添加猫咪 / 编辑猫咪」里选「口炎」「皮肤病」「其他」时，
 * addCat / updateCat 直接返回「健康状态取值不合法」，
 * **这个输入项完全不可用**。
 *
 * 本测试直接解析前端 wxml 的 data-value 选项，与后端常量比对，
 * 任何人改动其中一侧而不改另一侧都会红。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const { CAT_VALID_HEALTH_STATUS } = require(path.join(ROOT, 'cloudfunctions/utils/constants.js'));

/** 从录入页 wxml 提取 data-field="healthStatus" 的所有 data-value */
function collectFrontendOptions() {
  const files = [
    'pages/admin/add-cat/add-cat.wxml',
    'pages/admin/edit-cat/edit-cat.wxml'
  ];
  const values = new Set();
  files.forEach(f => {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    const re = /data-field="healthStatus"\s+data-value="([^"]+)"/g;
    let m;
    while ((m = re.exec(src)) !== null) values.add(m[1]);
  });
  return Array.from(values).sort();
}

describe('猫咪健康状态枚举前后端一致', () => {
  test('前端录入页的选项非空（避免正则失效导致空转通过）', () => {
    expect(collectFrontendOptions().length).toBeGreaterThan(0);
  });

  test('前端每个选项都被后端接受', () => {
    const opts = collectFrontendOptions();
    opts.forEach(v => {
      expect(CAT_VALID_HEALTH_STATUS).toContain(v);
    });
  });

  test('后端每个值都被前端提供（无凭空定义的枚举）', () => {
    const opts = collectFrontendOptions();
    CAT_VALID_HEALTH_STATUS.forEach(v => {
      expect(opts).toContain(v);
    });
  });

  test('详情页展示逻辑识别的状态值都在枚举内', () => {
    // detail.wxml 用 stomatitis / skin 做特殊展示，其余走默认分支
    const detail = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.wxml'), 'utf8');
    const found = new Set((detail.match(/healthStatus === '([a-z]+)'/g) || [])
      .map(s => s.split("'")[1]));
    found.forEach(v => {
      expect(CAT_VALID_HEALTH_STATUS).toContain(v);
    });
  });
});
