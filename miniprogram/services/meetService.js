// services/meetService.js - 相遇打卡数据服务（云函数调用封装）
const { Logger } = require('../utils/logger');
const { formatDateShort, formatTimeAgo } = require('../utils/dateFormat');
const { safePageSetData } = require('../utils/safePageSetData');
const statusTagUtil = require('../utils/statusTag');

/** 北京时间口径的今日日期串（与 getMyMeetCount 的 date 参数一致） */
function todayDateStr() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

/**
 * 今日打卡计数（请求在途期间共享）。
 *
 * detail.onLoad 里 checkTodayMeetStatus 与 loadRecentMeets 会各发一次
 * **参数完全相同**的 getMyMeetCount —— 同一次进入页面，同一份数据请求两遍。
 * 这里只在「请求在途期间」共享同一个 Promise：落账后立即清除，
 * 因此 onShow（从子页返回时）仍会拿新数据，不会读到旧结果。
 * 按 catId 校验，切换猫咪时天然不命中。
 *
 * 永不 reject（内部 catch 成 null）：两个消费方各自有降级分支，
 * 一边失败不能拖死另一边。
 */
function getTodayMeetCountPromise(page) {
  const catId = page.data.catId;
  if (page._todayCountCatId === catId && page._todayCountPromise) {
    return page._todayCountPromise;
  }

  const promise = wx.cloud.callFunction({
    name: 'getMyMeetCount',
    timeout: 5000,
    data: { catId, date: todayDateStr() }
  }).catch(err => {
    Logger.warn('detail', 'getMyMeetCount调用失败', { error: err.message });
    return null;
  }).then(res => {
    // 只合并同一 tick 内的重复请求；onShow 回来时重新取
    page._todayCountPromise = null;
    page._todayCountCatId = null;
    return res;
  });

  page._todayCountCatId = catId;
  page._todayCountPromise = promise;
  return promise;
}

module.exports = {
  async checkTodayMeetStatus(page) {
    try {
      const catId = page.data.catId;
      if (!catId) return;

      const res = await getTodayMeetCountPromise(page);

      // 后端 ok(data) 包装为 { success, data, message }，业务字段在 data 下
      const countData = res.result && res.result.data || res.result || {};
      const hasMet = res.result?.success && (countData.count || 0) > 0;
      safePageSetData(page, { hasMetToday: hasMet });
      // 注：此处曾写入 `meet_today_${catId}` 本地存储，但全项目无任何读取方，
      // 且用的是 UTC 日期（与上面的本地日期判断不一致），已于本次清理移除。
      // 今日是否已打卡以服务端 getMyMeetCount 为准，不做本地镜像。
    } catch (err) {
      Logger.warn('detail', '检查今日打卡状态失败', { error: err.message });
      safePageSetData(page, { hasMetToday: false });
    }
  },

  async submitMeet(page) {
    if (page.data.meetSubmitting) return;
    safePageSetData(page, { meetSubmitting: true });

    try {
      const catId = page.data.catId;
      const { selectedLocation, selectedStatusTag, isCustomStatus, customStatusText, meetNote, meetPoint } = page.data;
      // 落库口径：statusTag 只存纯文本（自定义前缀 已废弃，图标由显示层补）
      const statusTag = isCustomStatus && customStatusText.trim() ? customStatusText.trim() : selectedStatusTag;

      wx.showLoading({ title: '记录中…', mask: true });

      const res = await wx.cloud.callFunction({
        name: 'recordMeet',
        timeout: 10000,
        data: {
          catId,
          location: selectedLocation || '校园内',
          statusTag: statusTag || '相遇了',
          note: meetNote || '',
          // 可选的地图坐标。没选点时传 null —— 服务端会**保留**猫原来的
          // lastMeetPoint，而不是清空（否则一次纯文字打卡就把猫从地图上抹了）
          point: meetPoint ? { u: meetPoint.u, v: meetPoint.v } : null
        }
      });

      wx.hideLoading();

      if (!res.result?.success) {
        wx.showToast({ title: res.result?.error || res.result?.message || '打卡失败，请重试', icon: 'none' });
        return;
      }

      safePageSetData(page, {
        hasMetToday: true,
        showMeetPanel: false,
        selectedLocation: '',
        selectedStatusTag: '',
        isCustomStatus: false,
        customStatusText: '',
        meetNote: '',
        meetPoint: null
      });

      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });

      wx.showToast({
        title: '已记录！和TA的相遇',
        icon: 'none',
        duration: 2000
      });

      Logger.info('detail', '相遇打卡成功', { catId });

      try {
        const obsHelper = require('../utils/obsHelper');
        obsHelper.reportEvent(obsHelper.EVENT_NAMES?.MEET_RECORD || 'meet_record', { catId });
      } catch (e) { /* ignore */ }

      page.loadRecentMeets();
    } catch (err) {
      wx.hideLoading();
      Logger.error('detail', '提交相遇打卡失败', err);
      wx.showToast({ title: '打卡失败，请稍后再试', icon: 'none' });
    } finally {
      safePageSetData(page, { meetSubmitting: false });
    }
  },

  async loadRecentMeets(page) {
    try {
      const catId = page.data.catId;
      if (!catId) return;

      let recentMeets = [];
      let todayMeetCount = 0;

      // 两次云调用必须**并行**：串行会让「最近相遇」比其他区块晚整整一个往返，
      // 用户感知为「猫咪信息先出来、过一会儿最近相遇才蹦出来」。
      // 各自的失败互不影响（recentRes / countRes 为 null 时按空数据处理）。
      // count 复用 getTodayMeetCountPromise：checkTodayMeetStatus 刚在同一 tick
      // 发过同一请求，在途期间直接共用，省一次云调用（见该函数注释）。
      const [recentRes, countRes] = await Promise.all([
        wx.cloud.callFunction({
          name: 'getRecentMeets',
          timeout: 10000,
          data: { catId, limit: 5 }
        }).catch(recentErr => {
          Logger.warn('detail', 'getRecentMeets调用失败', { error: recentErr.message });
          return null;
        }),
        getTodayMeetCountPromise(page)
      ]);

      if (recentRes && recentRes.result && recentRes.result.success) {
        // 兼容 { data: { meets } } 与平铺 { meets } 两种返回结构
        const meetsData = recentRes.result.data && recentRes.result.data.meets || recentRes.result.meets || [];
        // 状态标签：新数据为纯文本；历史数据可能带 emoji 前缀，统一解析成 statusIcon/statusText
        recentMeets = meetsData.map(m => {
          const rawTime = m.createTime || m.meetTime;
          const tag = m.statusTag || '相遇了';
          return {
            ...m,
            ...statusTagUtil.decorateMeet({ statusTag: tag }),
            statusTag: tag,
            createTime: formatDateShort(rawTime),
            timeAgo: formatTimeAgo(rawTime)
          };
        });
      } else if (recentRes) {
        Logger.warn('detail', 'getRecentMeets返回失败', {
          success: recentRes.result?.success,
          message: recentRes.result?.message
        });
      }

      if (countRes && countRes.result && countRes.result.success) {
        todayMeetCount = ((countRes.result.data && countRes.result.data.count) ?? countRes.result.count) || 0;
      }

      safePageSetData(page, {
        recentMeets: recentMeets,
        todayMeetCount: todayMeetCount
      });

    } catch (err) {
      Logger.warn('detail', '加载最近相遇记录失败', { error: err.message });
      safePageSetData(page, { recentMeets: [], todayMeetCount: 0 });
    }
  }
};
