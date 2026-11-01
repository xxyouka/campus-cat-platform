// cloudfunctions/adminLogin/index.js - 管理员登录云函数
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const { getEffectivePermissions } = require('./utils/auth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PASSWORD_SALT = (process.env.PASSWORD_SALT || '').trim();
const ADMIN_ACCOUNT = (process.env.ADMIN_ACCOUNT || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const SUPER_ACCOUNT = (process.env.SUPER_ACCOUNT || '').trim();
const SUPER_PASSWORD = (process.env.SUPER_PASSWORD || '').trim();

if (!PASSWORD_SALT) {
  console.error('[adminLogin] 缺少必需的环境变量 PASSWORD_SALT');
}

const SCRYPT_KEY_LENGTH = 64;
const IS_PASSWORD_HASHED = ADMIN_PASSWORD.length === 128 && /^[a-fA-F0-9]{128}$/.test(ADMIN_PASSWORD);
const IS_PASSWORD_HASHED_LEGACY = ADMIN_PASSWORD.length === 64 && /^[a-fA-F0-9]{64}$/.test(ADMIN_PASSWORD);
const IS_SUPER_PASSWORD_HASHED = SUPER_PASSWORD.length === 128 && /^[a-fA-F0-9]{128}$/.test(SUPER_PASSWORD);
const IS_SUPER_PASSWORD_HASHED_LEGACY = SUPER_PASSWORD.length === 64 && /^[a-fA-F0-9]{64}$/.test(SUPER_PASSWORD);

// 预哈希部署陷阱的启动期告警（ENV_VARS.md 同名警告段的代码侧）
//
// 为什么必须在这里报、而不是靠登录时校验：配成明文时 IS_PASSWORD_HASHED 全为 false，
// verifyEnvPassword 的 scrypt/pbkdf2/legacy 三个分支一个都不走，函数**不报错**地
// 返回「账号或密码错误」——管理员看到的是「密码错了」，实际是「部署方式错了」，
// 排查方向完全被带偏（SECURITY.md §六「部署陷阱」）。
//
// 只在「配了但格式不对」时报：变量为空属于未启用该账号（登录走 DB 分支），不是配置错误。
function warnPlaintextPassword(label, value, isHashed, isLegacyHashed) {
  if (!value) return;
  if (isHashed || isLegacyHashed) return;
  console.error(
    `[adminLogin] ${label} 已配置，但不是合法的预哈希值（应为 64 位 sha256 或 128 位 scrypt/pbkdf2 的十六进制串）。\n` +
    '  该账号将**静默无法登录**（登录时报「账号或密码错误」，不提示部署原因）。\n' +
    '  生成方式见 cloudfunctions/ENV_VARS.md「密码与认证」：' +
    "scryptSync(明文, PASSWORD_SALT, 64).toString('hex') → 128 位"
  );
}
warnPlaintextPassword('ADMIN_PASSWORD', ADMIN_PASSWORD, IS_PASSWORD_HASHED, IS_PASSWORD_HASHED_LEGACY);
warnPlaintextPassword('SUPER_PASSWORD', SUPER_PASSWORD, IS_SUPER_PASSWORD_HASHED, IS_SUPER_PASSWORD_HASHED_LEGACY);

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');
}

function sha256Hash(password, salt) {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function pbkdf2Hash(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, SCRYPT_KEY_LENGTH, 'sha512').toString('hex');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a.padEnd(256, '\0'), 'utf8');
  const bufB = Buffer.from(b.padEnd(256, '\0'), 'utf8');
  return crypto.timingSafeEqual(bufA, bufB) && a.length === b.length;
}

function sanitize(str, maxLength) {
  if (typeof str !== 'string') return '';
  return str.substring(0, maxLength).trim();
}

function verifyEnvPassword(inputPassword, storedPassword, isScrypt, isLegacySha256) {
  // 优先尝试 scrypt
  if (isScrypt) {
    const inputHash = scryptHash(inputPassword, PASSWORD_SALT);
    const match = safeEqual(inputHash, storedPassword);
    if (match) return true;
  }
  // 兼容 pbkdf2（128位哈希但非scrypt时）
  if (!isLegacySha256 && storedPassword.length === 128) {
    const inputHash = pbkdf2Hash(inputPassword, PASSWORD_SALT);
    const match = safeEqual(inputHash, storedPassword);
    if (match) return true;
  }
  if (isLegacySha256) {
    const inputHash = sha256Hash(inputPassword, PASSWORD_SALT);
    const match = safeEqual(inputHash, storedPassword);
    if (match) return true;
  }
  return false;
}

const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_LOCK_TIME = 15 * 60 * 1000;
const ATTEMPTS_COLLECTION = COLLECTIONS.LOGIN_ATTEMPTS;

function checkLoginAttempts(dbInstance, clientId) {
  return dbInstance.collection(ATTEMPTS_COLLECTION)
    .where({ clientId: clientId })
    .limit(1)
    .get()
    .then(res => {
      const record = res.data[0];
      if (!record) return { blocked: false, attempts: 0 };
      const now = Date.now();
      if (record.lockUntil && now < record.lockUntil) {
        const remainingMinutes = Math.ceil((record.lockUntil - now) / (60 * 1000));
        return { blocked: true, message: '登录尝试过于频繁，请 ' + remainingMinutes + ' 分钟后再试' };
      }
      if (record.lockUntil && now >= record.lockUntil) {
        dbInstance.collection(ATTEMPTS_COLLECTION).doc(record._id).remove().catch(() => {});
        return { blocked: false, attempts: 0 };
      }
      return { blocked: false, attempts: record.count || 0, recordId: record._id };
    })
    .catch(() => ({ blocked: false, attempts: 0 }));
}

function recordLoginAttempt(dbInstance, clientId, success) {
  if (success) {
    return dbInstance.collection(ATTEMPTS_COLLECTION)
      .where({ clientId: clientId })
      .remove()
      .catch(() => {});
  }
  // 原子递增：读-改-写在并发下会互相覆盖，N 个并发失败登录计数只 +1，锁定形同虚设。
  // 先 update _.inc(1)，未命中（stats.updated === 0）再新建，新建竞争由超时兜底收敛。
  const now = Date.now();
  return dbInstance.collection(ATTEMPTS_COLLECTION)
    .where({ clientId: clientId })
    .update({
      data: {
        count: _.inc(1),
        lastAttemptTime: now,
        expireAt: new Date(now + 24 * 60 * 60 * 1000)
      }
    })
    .then(res => {
      if (res.stats && res.stats.updated > 0) {
        // 递增后判断是否达到锁定阈值，并落锁（再次原子写入，读数只在服务端日志使用）
        return dbInstance.collection(ATTEMPTS_COLLECTION)
          .where({ clientId: clientId })
          .limit(1)
          .get()
          .then(r => {
            const record = r.data[0];
            if (record && (record.count || 0) >= LOGIN_ATTEMPT_LIMIT && !record.lockUntil) {
              return dbInstance.collection(ATTEMPTS_COLLECTION).doc(record._id).update({
                data: {
                  lockUntil: now + LOGIN_LOCK_TIME,
                  expireAt: new Date(now + LOGIN_LOCK_TIME + 3600000)
                }
              });
            }
            return null;
          });
      }
      return dbInstance.collection(ATTEMPTS_COLLECTION).add({
        data: {
          clientId: clientId,
          count: 1,
          lastAttemptTime: now,
          expireAt: new Date(now + 24 * 60 * 60 * 1000)
        }
      });
    })
    .catch(() => {});
}

exports.main = async function(event) {
  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) { /* body不是JSON，忽略 */ }
  }

  const rawAccount = event.account;
  const rawPassword = event.password;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';

  // 限流键设计：Web 管理后台走 HTTP 触发器，WXContext.OPENID 恒为空。
  // 原实现退化成常量 'web_unknown' —— 全体网页端管理员共用一个计数桶，
  // 任意匿名者连打 5 次就能把所有人一起锁死 15 分钟（且成功后 .where().remove()
  // 清的是整桶，攻击者可持续重放触发）。这里改为按来源 IP 分桶。
  // 仍取不到 IP 时才退化到按账号分桶（见下），绝不使用全局共享常量。
  const headers = event && (event.headers || event.header) || {};
  const forwardedFor = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '';
  const realIp = headers['x-real-ip'] || headers['X-Real-IP'] || '';
  const clientIp = String(forwardedFor || realIp || '').split(',')[0].trim();
  const clientId = openid || (clientIp ? 'web_ip:' + clientIp : 'web_unknown');

  try {
    if (!PASSWORD_SALT) {
      return fail('服务器配置错误，请联系管理员');
    }

    const account = sanitize(rawAccount, 50);
    const password = sanitize(rawPassword, 128);

    if (!account || !password) {
      return fail('请输入账号和密码');
    }

    const attemptCheck = await checkLoginAttempts(db, clientId);
    if (attemptCheck.blocked) {
      return fail(attemptCheck.message);
    }

    // 账号维度第二层限流：只按 IP 限流时，攻击者换 IP 即可对同一账号无限撞库。
    // 这里对「被尝试的账号」单独计数，两层互相独立。
    const accountAttemptKey = 'acct:' + account.trim();
    if (accountAttemptKey !== clientId) {
      const accountAttemptCheck = await checkLoginAttempts(db, accountAttemptKey);
      if (accountAttemptCheck.blocked) {
        return fail(accountAttemptCheck.message);
      }
    }

    const inputAccount = account.trim();

    let loginRole = null;

    if (SUPER_ACCOUNT && SUPER_PASSWORD) {
      if (safeEqual(inputAccount, SUPER_ACCOUNT)) {
        if (verifyEnvPassword(
          password.trim(), SUPER_PASSWORD, IS_SUPER_PASSWORD_HASHED, IS_SUPER_PASSWORD_HASHED_LEGACY
        )) {
          // SUPER_ACCOUNT 是创始人（founder）的唯一事实源：凭据验证通过即创始人档，
          // 存量 superadmin 文档在下方登录流程中自动升格为 founder（幂等）。
          loginRole = 'founder';
        }
      }
    }

    if (!loginRole && ADMIN_ACCOUNT && ADMIN_PASSWORD) {
      if (safeEqual(inputAccount, ADMIN_ACCOUNT)) {
        if (verifyEnvPassword(password.trim(), ADMIN_PASSWORD, IS_PASSWORD_HASHED, IS_PASSWORD_HASHED_LEGACY)) {
          loginRole = 'admin';
        }
      }
    }

    if (loginRole) {
      const envAdminRes = await db.collection(COLLECTIONS.ADMINS)
        .where({ account: inputAccount })
        .limit(1)
        .get();

      const now = new Date().toISOString();
      // 返回给客户端的角色以**库中文档**为准：库里的 role 才是所有服务端校验的依据，
      // 只返回 env 凭据对应的 loginRole 会让客户端菜单/徽章与服务端实际权限不一致
      // （典型：库中该账号被改成 admin 后，env 登录仍显示超级管理员）。
      // 例外：SUPER_ACCOUNT（创始人）凭据验证通过即升格为 founder ——
      // 环境变量是 founder 的唯一事实源，不随库里被手改的角色漂移。
      let roleToReturn = loginRole;
      if (envAdminRes.data && envAdminRes.data.length > 0) {
        const existing = envAdminRes.data[0];
        if (loginRole !== 'founder' && existing.role) roleToReturn = existing.role;
        // role 写入口径分档：
        // - founder：存量 role 非 founder 时升格（幂等，SUPER_ACCOUNT 凭据即创始人）；
        // - 其余（ADMIN_ACCOUNT）：role 只在文档缺失时写入。原实现每次登录都覆写 role，
        //   而 SUPER_ACCOUNT 与 ADMIN_ACCOUNT 一旦配成同值（或历史文档 account 撞上
        //   ADMIN_ACCOUNT），用 admin 密码登录就会把 superadmin 静默降级为 admin 且不可逆。
        //
        // openid 绑定规则与下方 DB 分支同口径（此前这里缺失，导致 env 账号换微信/多人
        // 共用密码登录后：登录成功但服务端 checkAdmin 按真实 OPENID 查不到，所有操作
        // 报「无权限」）：
        //   1) 已有绑定 → 永不换绑，调用者不同则明确拒绝；
        //   2) 首次绑定前先确认该 openid 未绑定到其他管理员文档（防角色判定漂移）。
        if (existing.openid && existing.openid !== openid) {
          console.warn('[adminLogin] 环境变量账号已绑定其他微信，拒绝换绑');
          return fail('该账号已绑定其他微信，请联系超级管理员处理');
        }
        const patch = { lastLoginTime: now };
        if (loginRole === 'founder') {
          if (existing.role !== 'founder') patch.role = 'founder';
        } else if (!existing.role) {
          patch.role = loginRole;
        }
        if (!existing.openid) {
          if (!openid) {
            return fail('无法获取用户身份信息，请重试');
          }
          const dupRes = await db.collection(COLLECTIONS.ADMINS)
            .where({ openid, _id: _.neq(existing._id) })
            .limit(1)
            .get();
          if (dupRes.data && dupRes.data.length > 0) {
            console.warn('[adminLogin] 该 openid 已绑定其他管理员，拒绝重复绑定');
            return fail('该微信已绑定其他管理员账号，请使用对应微信登录');
          }
          patch.openid = openid;
        }
        // lastLoginTime 每次登录都是新值，所以这里不存在「无变化可跳过」的情形：
        // 先前用 `Object.keys(patch).length > 1` 判断，导致稳态账号
        // （已有 role、已绑定 openid）的 patch 恒为 { lastLoginTime } 一项、
        // 永远不落库 —— 管理端「最近登录时间」从此停在首次登录时间，
        // 既看不出管理员是否仍活跃，异常登录排查也失去依据。
        // 同函数 DB 账号分支（下方）本来就是无条件 update，这里与它对齐。
        await db.collection(COLLECTIONS.ADMINS).doc(existing._id).update({ data: patch });
      } else {
        // 文档缺失（首次用 env 凭据登录）：同样先做 openid 去重，避免重复绑定
        if (!openid) {
          return fail('无法获取用户身份信息，请重试');
        }
        const dupRes = await db.collection(COLLECTIONS.ADMINS)
          .where({ openid })
          .limit(1)
          .get();
        if (dupRes.data && dupRes.data.length > 0) {
          console.warn('[adminLogin] 该 openid 已绑定其他管理员，拒绝重复绑定');
          return fail('该微信已绑定其他管理员账号，请使用对应微信登录');
        }
        await db.collection(COLLECTIONS.ADMINS).add({
          data: {
            account: inputAccount,
            displayName: inputAccount,
            role: loginRole,
            openid,
            lastLoginTime: now,
            createdAt: now,
            isEnvAdmin: true
          }
        });
      }

      await recordLoginAttempt(db, clientId, true);
      if (accountAttemptKey !== clientId) {
        await recordLoginAttempt(db, accountAttemptKey, true);
      }
      // 登录即带回入口权限，客户端首屏菜单无需等一次额外云往返；
      // 历史 env 账号若还没有 permissions 字段，按默认 3 项返回。
      const permissions = envAdminRes.data && envAdminRes.data.length > 0
        ? getEffectivePermissions({ ...envAdminRes.data[0], role: roleToReturn })
        : getEffectivePermissions({ role: roleToReturn });
      return ok({ role: roleToReturn, permissions }, '登录成功');
    }

    const dbAdminRes = await db.collection(COLLECTIONS.ADMINS)
      .where({ account: inputAccount })
      .limit(1)
      .get();

    if (!dbAdminRes.data || dbAdminRes.data.length === 0) {
      await recordLoginAttempt(db, clientId, false);
      if (accountAttemptKey !== clientId) await recordLoginAttempt(db, accountAttemptKey, false);
      return fail('账号或密码错误');
    }

    const dbAdmin = dbAdminRes.data[0];

    if (!dbAdmin.password || !dbAdmin.salt) {
      await recordLoginAttempt(db, clientId, false);
      if (accountAttemptKey !== clientId) await recordLoginAttempt(db, accountAttemptKey, false);
      return fail('账号或密码错误');
    }

    let passwordValid = false;

    if (dbAdmin.hashAlgorithm === 'scrypt' || dbAdmin.password.length === 128) {
      try {
        const verifyHash = scryptHash(password.trim(), dbAdmin.salt);
        passwordValid = safeEqual(verifyHash, dbAdmin.password);
      } catch (e) {
        passwordValid = false;
      }
      // scrypt 失败时回退尝试 pbkdf2（兼容 admin server 创建的账号）
      if (!passwordValid) {
        try {
          const pbkdf2Verify = pbkdf2Hash(password.trim(), dbAdmin.salt);
          passwordValid = safeEqual(pbkdf2Verify, dbAdmin.password);
        } catch (e) {
          passwordValid = false;
        }
      }
    } else {
      const legacyHash = sha256Hash(password.trim(), dbAdmin.salt);
      passwordValid = safeEqual(legacyHash, dbAdmin.password);
      if (passwordValid) {
        const newSalt = crypto.randomBytes(16).toString('hex');
        const newHash = scryptHash(password.trim(), newSalt);
        await db.collection(COLLECTIONS.ADMINS).doc(dbAdmin._id).update({
          data: { password: newHash, salt: newSalt, hashAlgorithm: 'scrypt' }
        });
      }
    }

    if (!passwordValid) {
      await recordLoginAttempt(db, clientId, false);
      if (accountAttemptKey !== clientId) await recordLoginAttempt(db, accountAttemptKey, false);
      return fail('账号或密码错误');
    }

    const now = new Date().toISOString();

    // openid 绑定规则（与环境变量管理员分支同口径）：
    //   1. 已有绑定时**永不覆盖/换绑** —— 原实现每次登录都无条件写 openid，
    //      任何拿到密码的人登录一次就能把管理员身份迁移到自己的微信；
    //   2. 首次绑定前先确认该 openid 未绑定到**其他**管理员文档 —— 否则
    //      checkAdmin 的 `.where({openid}).limit(1)` 会命中两条记录里不确定的一条，
    //      角色判定随之漂移。典型触发：超管在自己的开发者工具上测试子账号登录，
    //      同一 openid 同时挂在超管与子账号两条文档上 → 超管可能判成普通 admin，
    //      所有超管功能被服务端拒绝。
    const bindingPatch = { lastLoginTime: now };

    if (!dbAdmin.openid) {
      const dupRes = await db.collection(COLLECTIONS.ADMINS)
        .where({ openid, _id: _.neq(dbAdmin._id) })
        .limit(1)
        .get();
      if (dupRes.data && dupRes.data.length > 0) {
        console.warn('[adminLogin] 该 openid 已绑定其他管理员，拒绝重复绑定');
        return fail('该微信已绑定其他管理员账号，请使用对应微信登录');
      }
      bindingPatch.openid = openid;
    } else if (dbAdmin.openid !== openid) {
      // 绑定冲突不是凭据错误，不计入失败限流（否则会把合法管理员锁 15 分钟）
      console.warn('[adminLogin] 账号已绑定其他微信，拒绝换绑');
      return fail('该账号已绑定其他微信，请联系超级管理员处理');
    }

    await db.collection(COLLECTIONS.ADMINS).doc(dbAdmin._id).update({
      data: bindingPatch
    });

    await recordLoginAttempt(db, clientId, true);
    if (accountAttemptKey !== clientId) {
      await recordLoginAttempt(db, accountAttemptKey, true);
    }

    return ok({
      role: dbAdmin.role || 'admin',
      permissions: getEffectivePermissions(dbAdmin)
    }, '登录成功');
  } catch (err) {
    console.error('[adminLogin] 未预期错误:', err);
    return fail('服务器内部错误');
  }
};
