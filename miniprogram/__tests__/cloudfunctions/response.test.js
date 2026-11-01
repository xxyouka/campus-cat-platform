const { ok, fail } = require('../../cloudfunctions/utils/response');

describe('response.ok', () => {
  test('返回成功响应含data和message', async () => {
    const result = await ok({ cats: [], total: 0 }, '查询完成');
    expect(result).toEqual({
      success: true,
      data: { cats: [], total: 0 },
      message: '查询完成'
    });
  });

  test('无message时默认为空字符串', async () => {
    const result = await ok({ id: '123' });
    expect(result).toEqual({
      success: true,
      data: { id: '123' },
      message: ''
    });
  });

  test('无data时默认为null', async () => {
    const result = await ok();
    expect(result).toEqual({
      success: true,
      data: null,
      message: ''
    });
  });

  test('data为0时保留值', async () => {
    const result = await ok(0, '计数');
    expect(result.data).toBe(0);
  });

  test('data为false时保留值', async () => {
    const result = await ok(false, '状态');
    expect(result.data).toBe(false);
  });
});

describe('response.fail', () => {
  test('返回失败响应含error和code', async () => {
    const result = await fail('参数错误', 'INVALID_PARAM');
    expect(result).toEqual({
      success: false,
      data: null,
      message: '',
      error: '参数错误',
      code: 'INVALID_PARAM'
    });
  });

  test('无参数时使用默认值', async () => {
    const result = await fail();
    expect(result).toEqual({
      success: false,
      data: null,
      message: '',
      error: '未知错误',
      code: 'ERROR'
    });
  });

  test('仅提供error', async () => {
    const result = await fail('权限不足');
    expect(result.error).toBe('权限不足');
    expect(result.code).toBe('ERROR');
  });
});
