// __tests__/cloudfunctions/changeSummary.test.js
// 定向回归：操作日志「摘要层」的核心口径。
//
// 这个模块存在的理由是 updateCat 历史上只把 3 个字段写进 beforeData/afterData，
// 其余改动在源头就丢了 —— 所以「改了啥」必须在写入时算出来。
// 下面锁死的是管理员在日志里会直接读到的文案，不要随手改。
const {
  diffCatFields,
  buildSummary,
  sanitizeChanges,
  formatFieldValue,
  MAX_CHANGES
} = require('../../cloudfunctions/common/changeSummary');

describe('changeSummary (cloudfunctions/common/changeSummary.js)', () => {
  describe('diffCatFields —— 只报真正改了的字段', () => {
    test('after 中不存在的字段一律不参与比对', () => {
      // updateCat 只下发本次实际修改的字段。若把 undefined 的字段也比一遍，
      // 「只改个名字」就会凭空多出十几行「校区 空 → 空」的噪音。
      const before = { name: '小花', campus: '中心校区', age: '3岁', color: '橘白' };
      const changes = diffCatFields(before, { name: '小花生' });

      expect(changes).toEqual([{ label: '名字', from: '小花', to: '小花生' }]);
    });

    test('提交了但取值相同的字段不进明细', () => {
      const before = { name: '小花', status: 'normal' };
      const changes = diffCatFields(before, { name: '小花', status: 'normal' });
      expect(changes).toEqual([]);
    });

    test('枚举字段转成管理端按钮上的中文文案', () => {
      // 文案必须与 pages/admin/edit-cat 的按钮逐字一致，
      // 否则日志里的「状态」和管理员刚点的那个「状态」对不上
      const changes = diffCatFields(
        { status: 'normal', healthStatus: 'healthy' },
        { status: 'lost', healthStatus: 'stomatitis' }
      );

      expect(changes).toEqual([
        { label: '状态', from: '在校', to: '走失' },
        { label: '健康状态', from: '健康', to: '口炎' }
      ]);
    });

    test('清空字段显示为「空」而不是空字符串', () => {
      // 变更明细里出现「年龄：（空）」看不出发生了什么
      const changes = diffCatFields({ age: '3岁' }, { age: '' });
      expect(changes).toEqual([{ label: '年龄', from: '3岁', to: '空' }]);
    });

    test('明细顺序按 CAT_ALLOWED_FIELDS 固定，不随对象键序漂移', () => {
      const changes = diffCatFields(
        { name: '小花', campus: 'A', status: 'normal' },
        { status: 'lost', campus: 'B', name: '小花生' }
      );
      expect(changes.map(c => c.label)).toEqual(['名字', '校区', '状态']);
    });

    test('布尔型绝育状态转中文', () => {
      expect(diffCatFields({ sterilized: 0 }, { sterilized: 1 }))
        .toEqual([{ label: '绝育状态', from: '未绝育', to: '已绝育' }]);
    });

    test('好猫星级：0 与字段缺失语义等价，不产生假变更', () => {
      // 编辑页会固定下发 adoptLevel（未评级时是 0）。若按 String 比较，
      // 给从未评级的旧文档保存一次昵称都会多出「好猫星级 空 → 未评级」的噪音。
      expect(diffCatFields({}, { adoptLevel: 0 })).toEqual([]);
      expect(diffCatFields({ adoptLevel: 0 }, { adoptLevel: 0 })).toEqual([]);
      expect(diffCatFields({ adoptLevel: undefined }, { adoptLevel: 0 })).toEqual([]);
    });

    test('好猫星级：真实变化记录为「N 星」，取消评级显示「未评级」', () => {
      expect(diffCatFields({ adoptLevel: 3 }, { adoptLevel: 5 }))
        .toEqual([{ label: '好猫星级', from: '3 星', to: '5 星' }]);
      expect(diffCatFields({ adoptLevel: 5 }, { adoptLevel: 0 }))
        .toEqual([{ label: '好猫星级', from: '5 星', to: '未评级' }]);
    });

    test('超长文本截断，避免日志卡片被撑爆', () => {
      const long = '猫'.repeat(200);
      const changes = diffCatFields({ description: '旧' }, { description: long });

      expect(changes).toHaveLength(1);
      expect(changes[0].to.length).toBeLessThanOrEqual(61); // 60 + 省略号
      expect(changes[0].to.endsWith('…')).toBe(true);
    });

    test('明细条数封顶，避免一次全量编辑刷爆列表', () => {
      const before = { name: 'a', age: '1', color: 'b', description: 'c' };
      const after = { name: 'z', age: '9', color: 'y', description: 'x' };
      expect(diffCatFields(before, after).length).toBeLessThanOrEqual(MAX_CHANGES);
    });
  });

  describe('diffCatFields —— 图片类字段', () => {
    test('只记张数，不落 fileID（fileID 无可读性且临时链会过期）', () => {
      const changes = diffCatFields(
        { images: [] },
        { images: ['cloud://env.x/photos/a.jpg', 'cloud://env.x/photos/b.jpg'] }
      );
      expect(changes).toEqual([{ label: '图片', text: '新增 2 张' }]);
    });

    test('换一张图（删 1 加 1，长度不变）仍要被记下来', () => {
      // 长度差会漏掉「换图」，而换图正是最该记录的操作之一
      const changes = diffCatFields(
        { images: ['cloud://env.x/photos/old.jpg'] },
        { images: ['cloud://env.x/photos/new.jpg'] }
      );
      expect(changes).toEqual([{ label: '图片', text: '新增 1 张，移除 1 张' }]);
    });

    test('图片顺序调整不算变更', () => {
      const before = { images: ['a', 'b'] };
      const changes = diffCatFields(before, { images: ['b', 'a'] });
      expect(changes).toEqual([]);
    });

    test('头像只记「有没有换」，不暴露 fileID', () => {
      const changes = diffCatFields(
        { avatar: 'cloud://env.x/cats/avatar/old.jpg' },
        { avatar: 'cloud://env.x/cats/avatar/new.jpg' }
      );
      expect(changes).toEqual([{ label: '头像', from: '已设置', to: '已设置' }]);
      expect(JSON.stringify(changes)).not.toContain('cloud://');
    });
  });

  describe('buildSummary —— 拼成一行人话', () => {
    test('变更明细拼成「字段 旧 → 新」', () => {
      const changes = diffCatFields(
        { name: '小花', status: 'normal' },
        { name: '小花', status: 'lost' }
      );
      expect(buildSummary('编辑猫咪「小花」', changes))
        .toBe('编辑猫咪「小花」：状态 在校 → 走失');
    });

    test('text 型明细不带「旧 → 新」结构', () => {
      const changes = [{ label: '新增照片', text: '1 张（归属：小花）' }];
      expect(buildSummary('上传照片', changes))
        .toBe('上传照片：新增照片 1 张（归属：小花）');
    });

    test('无变更时只返回标题，不留孤零零的冒号', () => {
      expect(buildSummary('编辑猫咪「小花」', [])).toBe('编辑猫咪「小花」');
      expect(buildSummary('编辑猫咪「小花」', null)).toBe('编辑猫咪「小花」');
    });

    test('超出上限的明细在末尾以「等共 N 项」收口', () => {
      const many = Array.from({ length: MAX_CHANGES + 3 }, (_, i) => ({
        label: `字段${i}`, from: 'a', to: 'b'
      }));
      expect(buildSummary('编辑', many)).toContain(`等共 ${MAX_CHANGES + 3} 项`);
    });

    test('整行长度封顶', () => {
      const many = Array.from({ length: MAX_CHANGES }, (_, i) => ({
        label: `字段${i}`, from: 'x'.repeat(60), to: 'y'.repeat(60)
      }));
      expect(buildSummary('编辑', many).length).toBeLessThanOrEqual(200);
    });
  });

  describe('sanitizeChanges —— 写库前的最后一道闸', () => {
    test('丢弃非对象项与空 label', () => {
      const result = sanitizeChanges([
        null,
        'not an object',
        { label: '状态', from: '在校', to: '走失' },
        { label: '   ' }
      ]);
      expect(result).toEqual([{ label: '状态', from: '在校', to: '走失' }]);
    });

    test('非数组输入降级为空数组（不写该字段）', () => {
      expect(sanitizeChanges(undefined)).toEqual([]);
      expect(sanitizeChanges({ label: 'x' })).toEqual([]);
    });

    test('单条文本封顶，防止超长备注撑爆日志文档', () => {
      const [item] = sanitizeChanges([{ label: '备注', from: 'a'.repeat(500), to: 'b' }]);
      expect(item.from.length).toBeLessThanOrEqual(61);
    });

    test('条数封顶', () => {
      const many = Array.from({ length: MAX_CHANGES + 10 }, (_, i) => ({
        label: `字段${i}`, from: 'a', to: 'b'
      }));
      expect(sanitizeChanges(many).length).toBe(MAX_CHANGES);
    });

    test('text 型条目保留 text，不被补成空的 from/to', () => {
      const [item] = sanitizeChanges([{ label: '图片', text: '新增 2 张' }]);
      expect(item).toEqual({ label: '图片', text: '新增 2 张' });
      expect(item).not.toHaveProperty('from');
    });
  });

  describe('formatFieldValue', () => {
    test('空值统一显示「空」', () => {
      expect(formatFieldValue('age', undefined)).toBe('空');
      expect(formatFieldValue('age', null)).toBe('空');
      expect(formatFieldValue('age', '')).toBe('空');
    });

    test('标签数组拼接展示', () => {
      expect(formatFieldValue('tags', ['亲人', '能摸'])).toBe('亲人、能摸');
      expect(formatFieldValue('tags', [])).toBe('无');
    });

    test('好猫星级：0 是「未评级」，正整数带「星」', () => {
      expect(formatFieldValue('adoptLevel', 0)).toBe('未评级');
      expect(formatFieldValue('adoptLevel', 3)).toBe('3 星');
      expect(formatFieldValue('adoptLevel', 5)).toBe('5 星');
    });
  });
});