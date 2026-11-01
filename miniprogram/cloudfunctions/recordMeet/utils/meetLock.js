const crypto = require('crypto');

const SYSTEM_STATE_COLLECTION = 'system_state';
const LOCK_PREFIX = 'record_meet_lock_';
const LOCK_LEASE_MS = 90 * 1000;
const MAX_ACQUIRE_ATTEMPTS = 3;

function lockIdFor(catId, openid) {
  const digest = crypto.createHash('sha256').update(`${catId}|${openid}`).digest('hex');
  return `${LOCK_PREFIX}${digest.slice(0, 32)}`;
}

function newOwnerToken() {
  return crypto.randomBytes(16).toString('hex');
}

function isDuplicateIdError(err) {
  const message = err && (err.errMsg || err.message) || '';
  return !!(err && (err.errCode === -502001 ||
    /duplicate key|already exists|_id.*(exist|conflict)/i.test(message)));
}

/** Acquire a short lease for one (catId, openid) pair across function instances. */
async function acquireMeetLock(db, catId, openid, now = Date.now()) {
  const collection = db.collection(SYSTEM_STATE_COLLECTION);
  const lockId = lockIdFor(catId, openid);
  const ownerToken = newOwnerToken();

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const stateRes = await collection.where({ _id: lockId }).limit(1).get();
    const existing = stateRes && Array.isArray(stateRes.data) ? stateRes.data[0] : null;

    if (existing) {
      const leaseUntil = Number(existing.leaseUntil);
      // A malformed lock fails closed rather than allowing concurrent writes.
      if (!Number.isFinite(leaseUntil)) return { acquired: false };
      if (leaseUntil > now) return { acquired: false };

      const cas = await collection.where({
        _id: lockId,
        ownerToken: existing.ownerToken,
        leaseUntil: existing.leaseUntil
      }).update({
        data: {
          ownerToken,
          leaseUntil: now + LOCK_LEASE_MS,
          updateTime: db.serverDate()
        }
      });
      if (Number(cas && cas.stats && cas.stats.updated) === 1) {
        return { acquired: true, lockId, ownerToken };
      }
      continue;
    }

    try {
      await collection.add({
        data: {
          _id: lockId,
          key: 'record_meet_lock',
          ownerToken,
          leaseUntil: now + LOCK_LEASE_MS,
          createTime: db.serverDate(),
          updateTime: db.serverDate()
        }
      });
      return { acquired: true, lockId, ownerToken };
    } catch (err) {
      if (!isDuplicateIdError(err)) throw err;
      // Another invocation created this pair's lock; reread its lease.
    }
  }

  return { acquired: false };
}

async function releaseMeetLock(db, lock) {
  if (!lock || !lock.acquired) return false;
  const result = await db.collection(SYSTEM_STATE_COLLECTION)
    .where({ _id: lock.lockId, ownerToken: lock.ownerToken })
    .remove();
  return Number(result && result.stats && result.stats.removed) === 1;
}

module.exports = { acquireMeetLock, releaseMeetLock, lockIdFor, LOCK_LEASE_MS };
