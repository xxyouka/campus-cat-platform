const DEFAULT_BATCH_SIZE = 100;

function validatePage(rows, cursorId, batchSize) {
  if (!Array.isArray(rows) || rows.length > batchSize) {
    throw new Error('数据库分页返回结构异常');
  }

  let previousId = cursorId || '';
  for (const row of rows) {
    if (!row || typeof row._id !== 'string' || !row._id || row._id <= previousId) {
      throw new Error('数据库分页 _id 缺失、重复或未按升序前进');
    }
    previousId = row._id;
  }
}

async function backupCollection(db, command, collectionName, batchSize = DEFAULT_BATCH_SIZE) {
  const allData = [];
  let cursorId = '';
  let hasMore = true;

  while (hasMore) {
    let query = db.collection(collectionName);
    if (cursorId) query = query.where({ _id: command.gt(cursorId) });

    const result = await query.orderBy('_id', 'asc').limit(batchSize).get();
    const rows = result && result.data;
    validatePage(rows, cursorId, batchSize);
    if (rows.length === 0) {
      hasMore = false;
      continue;
    }

    allData.push(...rows);
    cursorId = rows[rows.length - 1]._id;
    hasMore = rows.length === batchSize;
  }

  return allData;
}

module.exports = { backupCollection, validatePage };
