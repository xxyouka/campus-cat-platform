const { acquireMeetLock, releaseMeetLock, lockIdFor } = require('../../cloudfunctions/utils/meetLock');

function createDb(initialDocuments = []) {
  const documents = new Map(initialDocuments.map(document => [document._id, { ...document }]));
  const matches = (document, condition) => document &&
    Object.entries(condition).every(([key, value]) => document[key] === value);

  const collection = {
    where: jest.fn(condition => ({
      limit: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({
          data: documents.has(condition._id) ? [{ ...documents.get(condition._id) }] : []
        }))
      })),
      update: jest.fn(({ data }) => {
        const current = documents.get(condition._id);
        if (!matches(current, condition)) return Promise.resolve({ stats: { updated: 0 } });
        documents.set(condition._id, { ...current, ...data });
        return Promise.resolve({ stats: { updated: 1 } });
      }),
      remove: jest.fn(() => {
        const current = documents.get(condition._id);
        if (!matches(current, condition)) return Promise.resolve({ stats: { removed: 0 } });
        documents.delete(condition._id);
        return Promise.resolve({ stats: { removed: 1 } });
      })
    })),
    add: jest.fn(({ data }) => {
      if (documents.has(data._id)) {
        const error = new Error('duplicate key');
        error.errCode = -502001;
        return Promise.reject(error);
      }
      documents.set(data._id, { ...data });
      return Promise.resolve({ _id: data._id });
    })
  };
  return {
    db: { collection: jest.fn(() => collection), serverDate: jest.fn(() => new Date(0)) },
    documents
  };
}

describe('recordMeet 按用户/猫咪串行化', () => {
  test('并发竞争同一个新锁时只有一个调用获得租约', async () => {
    const { db, documents } = createDb();
    const [first, second] = await Promise.all([
      acquireMeetLock(db, 'cat-a', 'user-a', 1000),
      acquireMeetLock(db, 'cat-a', 'user-a', 1000)
    ]);

    expect([first.acquired, second.acquired].filter(Boolean)).toHaveLength(1);
    expect(documents.size).toBe(1);
    const owner = first.acquired ? first : second;
    const contender = first.acquired ? second : first;
    expect(contender.acquired).toBe(false);
    expect(await releaseMeetLock(db, owner)).toBe(true);
    expect(documents.size).toBe(0);
  });

  test('过期租约可被接管，旧 owner 不能释放新 owner 的锁', async () => {
    const lockId = lockIdFor('cat-a', 'user-a');
    const { db, documents } = createDb([{
      _id: lockId,
      key: 'record_meet_lock',
      ownerToken: 'expired-owner',
      leaseUntil: 500
    }]);

    const replacement = await acquireMeetLock(db, 'cat-a', 'user-a', 1000);
    expect(replacement.acquired).toBe(true);
    expect(replacement.ownerToken).not.toBe('expired-owner');
    expect(await releaseMeetLock(db, { acquired: true, lockId, ownerToken: 'expired-owner' })).toBe(false);
    expect(documents.get(lockId).ownerToken).toBe(replacement.ownerToken);
    expect(await releaseMeetLock(db, replacement)).toBe(true);
    expect(documents.has(lockId)).toBe(false);
  });
});
