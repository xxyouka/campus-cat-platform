const { backupCollection } = require('../../cloudfunctions/backupData/backupCollection');

function makeDatabase(rows, onFirstPage) {
  let cursorId = '';
  let pageSize = 0;
  let pageCalls = 0;
  const query = {
    where(condition) {
      cursorId = condition._id;
      return query;
    },
    orderBy: jest.fn(() => query),
    limit(size) {
      pageSize = size;
      return query;
    },
    async get() {
      const data = rows
        .filter(row => !cursorId || row._id > cursorId)
        .sort((a, b) => a._id.localeCompare(b._id))
        .slice(0, pageSize);
      pageCalls++;
      if (pageCalls === 1 && onFirstPage) onFirstPage();
      return { data };
    }
  };
  return {
    db: { collection: jest.fn(() => query) },
    get pageCalls() { return pageCalls; }
  };
}

describe('backupData cursor pagination', () => {
  test('does not skip remaining documents when earlier rows are deleted between pages', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      _id: String(index + 1).padStart(3, '0'),
      value: index + 1
    }));
    const initialIds = rows.map(row => row._id);
    const database = makeDatabase(rows, () => {
      rows.splice(0, 1);
    });

    const result = await backupCollection(database.db, { gt: value => value }, 'cats');

    expect(result.map(row => row._id)).toEqual(initialIds);
    expect(new Set(result.map(row => row._id)).size).toBe(initialIds.length);
    expect(database.pageCalls).toBe(3);
  });

  test('rejects a page whose identifiers do not advance strictly', async () => {
    const query = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      get: jest.fn()
        .mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, index) => ({ _id: `id-${String(index).padStart(3, '0')}` })) })
        .mockResolvedValueOnce({ data: [{ _id: 'id-099' }] })
    };
    const database = { collection: jest.fn(() => query) };

    await expect(backupCollection(database, { gt: value => value }, 'cats'))
      .rejects.toThrow('数据库分页 _id 缺失、重复或未按升序前进');
  });
});
