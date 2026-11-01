/**
 * pages/admin/add-cat/add-cat.js - 添加猫咪页面
 * 
 * 职责：
 * 1. 填写猫咪基本信息
 * 2. 上传大头照
 * 3. 提交到云数据库
 */
const { requireAdminAuth, checkAdminAuthAsync } = require('../../../utils/adminAuth');
const ErrorHandler = require('../../../utils/errorHandler');
const { Logger } = require('../../../utils/logger');
const { getPageStateManager } = require('../../../utils/pageState');
const obsHelper = require('../../../utils/obsHelper');
// 选图必须经兼容层：PC 端不支持 wx.chooseMedia，直调会静默无响应
const { pickImages } = require('../utils/mediaChoose');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');
// 头像必须压缩：云函数 checkImage 用 imgSecCheck 校验服务端实际字节数，超过 1M 一律拒绝。
// 此前头像走裸上传（一张没压），手机原图动辄数 MB，必然被拒且失败发生在文件已落盘之后。
const { compressToLimit } = require('../utils/imageCompressor');
const config = require('../../../config');

Page({
  behaviors: [adminBehavior, safeSetDataBehavior],
  // ========== 生命周期 ==========

  async onLoad() {
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能只 return：提示后延迟返回，避免停在半初始化页面
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return;
    }
    if (!this.guardPermission('addCat', '添加新猫')) return;

    const windowInfo = wx.getWindowInfo();
    this.safeSetData({ statusBarHeight: windowInfo.statusBarHeight || 0 });
  },


  // ========== 数据 ==========
  data: {
    statusBarHeight: 0,
    avatar: null,
    loading: false,
    inputFocus: false,
    // 长度上限从 config.security 注入（wxml maxlength 绑这两个）。
    // 原为 wxml 里硬编码 maxlength="20"/"200"，比服务端
    // CAT_FIELD_LENGTH_LIMITS（name 50 / description 500）更严：
    // 改 config 不会生效，且 20~50 字的合法名字被前端硬截断。
    maxNameLength: config.security.maxNameLength,
    maxDescriptionLength: config.security.maxDescriptionLength,
    form: {
      name: '',
      gender: '',
      age: '成年',
      color: '',
      sterilized: null,
      location: '',
      campus: '',
      status: 'normal',
      // 好猫星级（0 = 不评；3/4/5 = 星级）。只给明显更适合家养的猫打分，不是必填
      adoptLevel: 0,
      deceasedTime: '',
      deceasedReason: '',
      lostTime: '',
      lostLocation: '',
      description: '',
      appearance: '',
      notes: '',
      healthStatus: 'healthy',
      healthNote: ''
    }
  },

  // ========== 表单输入 ==========

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onInputFocus() {
    this.setData({ inputFocus: true });
  },

  onInputBlur() {
    this.setData({ inputFocus: false });
  },

  onOption(e) {
    const { field, value } = e.currentTarget.dataset;
    this.setData({ [`form.${field}`]: value });
  },

  onSterilized(e) {
    const val = e.currentTarget.dataset.value;
    let sterilized = null;
    if (val === 'true') sterilized = true;
    else if (val === 'false') sterilized = false;
    this.setData({ 'form.sterilized': sterilized });
  },

  /**
   * 好猫星级（0 = 不评；3/4/5 = 星级）。
   * dataset 里取到的是字符串，必须转成数字 —— 云函数只接受 0 或 3/4/5 的整数
   */
  onAdoptLevel(e) {
    const level = Number(e.currentTarget.dataset.value) || 0;
    this.setData({ 'form.adoptLevel': level });
  },

  onDate(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  // ========== 操作 ==========

  async onChooseAvatar() {
    // 防重入：选择过程中连点会叠开多个选择器（PC 端回退路径下尤其明显）
    if (this._choosingAvatar) return;
    this._choosingAvatar = true;

    try {
      const res = await pickImages({ count: 1 });
      if (res.ok) {
        this.setData({ avatar: res.files[0].tempFilePath });
      } else if (!res.cancelled) {
        // 失败必须给出反馈：此前只传 success，PC 端点了完全没反应，用户无法判断原因
        ErrorHandler.handle(new Error(res.error && res.error.errMsg || '选择图片失败'), {
          title: '选择图片失败'
        });
      }
    } finally {
      this._choosingAvatar = false;
    }
  },

  onRemoveAvatar() {
    this.setData({ avatar: null });
  },

  onCancel() {
    wx.navigateBack();
  },

  // ========== 提交 ==========

  async onSave() {
    const { form, avatar, loading } = this.data;
    if (loading || this._saving) return;
    this._saving = true;

    const authRes = await checkAdminAuthAsync();
    if (!authRes.verified) {
      this._saving = false;
      wx.showModal({
        title: '权限失效',
        content: '管理员身份已失效，请重新登录',
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }

    if (!form.name?.trim()) {
      this._saving = false;
      ErrorHandler.handleValidationError('猫咪名字', '不能为空');
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      return;
    }
    if (!avatar) {
      this._saving = false;
      ErrorHandler.handleValidationError('大头照', '至少上传一张');
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      return;
    }

    this.setData({ loading: true });

    // 上传成功但后续步骤抛错时用于回收（见 catch）：
    // avatarUrl 原先声明在 try 内，catch 看不到，上传成功后的异常必然留下孤儿文件
    let uploadedAvatarUrl = '';
    // addCat 是否已发起：发起后 reject（超时/断网）属**歧义失败** —— 服务端可能已入库，
    // 此时删文件会把头像变成坏图（孤儿文件只是不可见垃圾，坏图是用户可见损坏）
    let addAttempted = false;

    try {
      wx.showLoading({ title: '压缩中…', mask: true });

      // 压到 1M 以内（与云函数 contentSecurity.IMAGE_MAX_BYTES 对齐）。
      // 留 100KB 余量：换链/编码差异可能让实际字节数略增
      const AVATAR_MAX_BYTES = 950 * 1024;
      const compressed = await compressToLimit(avatar, AVATAR_MAX_BYTES);
      if (!compressed.withinLimit) {
        wx.hideLoading();
        ErrorHandler.handle(new Error('图片过大，压缩后仍超过 1M，请换一张尺寸更小的照片'), {
          title: '图片过大'
        });
        return;
      }

      wx.showLoading({ title: '上传中…', mask: true });

      const extMatch = compressed.path.match(/\.(\w+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
      const safeExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg';
      // 追加随机段：云存储同路径是覆盖写，仅毫秒时间戳在两台设备同毫秒上传时
      // 会让两只猫的头像指向同一文件（跨猫串图），album-detail 早已这么做
      const cloudPath = `cats/avatar/${Date.now()}_${Math.random().toString(36).slice(2, 11)}.${safeExt}`;

      const uploadRes = await this._uploadWithProgress(cloudPath, compressed.path);
      if (!uploadRes || !uploadRes.fileID) {
        throw new Error('头像上传失败，未获取到文件ID');
      }
      const avatarUrl = uploadRes.fileID;
      uploadedAvatarUrl = avatarUrl;

      wx.showLoading({ title: '保存中…', mask: true });
      const catData = {
        name: form.name.trim(),
        gender: form.gender,
        age: form.age,
        sterilized: form.sterilized,
        color: form.color?.trim() || '',
        description: form.description?.trim() || '',
        appearance: form.appearance?.trim() || '',
        campus: form.campus || '',
        location: form.location?.trim() || '',
        // 好猫星级：0/3/4/5，缺省的「不评」下发 0（服务端把 0 视为未评级）
        adoptLevel: form.adoptLevel || 0,
        status: form.status,
        deceasedTime: form.deceasedTime || '',
        deceasedReason: form.deceasedReason?.trim() || '',
        lostTime: form.lostTime || '',
        lostLocation: form.lostLocation?.trim() || '',
        avatar: avatarUrl,
        images: [],
        tags: [],
        notes: form.notes?.trim() || '',
        healthStatus: form.healthStatus || 'healthy',
        healthNote: form.healthNote?.trim() || ''
      };
      addAttempted = true;
      const res = await this.callAdminFunction('addCat', { catData });

      wx.hideLoading();
      if (!res.result?.success) {
        // 已上传但未入库（服务端明确拒绝）→ 现场清理，避免留下孤儿文件
        await this._cleanupUploadedFile(avatarUrl);
        uploadedAvatarUrl = '';
        ErrorHandler.handle(new Error(res.result?.error || '添加失败'), { title: '添加失败' });
        return;
      }
      // 已入库：文件归猫咪所有，后续任何异常都不得再回收
      uploadedAvatarUrl = '';
      // 页面已卸载（用户保存期间退出）：不再弹提示/排返回 —— 否则定时器在卸载后才赋值，
      // onUnload 清不到，1.5s 后会对用户当前所在页面多 pop 一级
      if (this._isUnmounted) return;
      // 保持提交锁直到跳转：窗口期内二次点击会再走一遍上传+addCat，生成重复猫咪
      this._savedOk = true;
      ErrorHandler.showSuccess('添加成功');

      obsHelper.reportEvent(obsHelper.EVENT_NAMES.ADMIN_ADD_CAT, {});

      getPageStateManager().setNeedRefresh('index', { action: 'add' });
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
    } catch (err) {
      wx.hideLoading();
      // 仅在「尚未发起 addCat」时回收（压缩/上传阶段异常 ⇒ 必然未入库）；
      // 已发起后 reject（超时/断网）结果未知：服务端可能已写入，删文件会毁掉已入库的头像
      if (uploadedAvatarUrl && !addAttempted) {
        await this._cleanupUploadedFile(uploadedAvatarUrl);
      }
      Logger.warn('add-cat', '添加猫咪失败', { error: err.message });
      ErrorHandler.handle(err, { title: '添加失败' });
    } finally {
      // 成功路径保持锁与 loading（按钮不可用直到跳转，防二次提交）；失败路径复位
      if (!this._savedOk) {
        this.safeSetData({ loading: false });
        this._saving = false;
      }
    }
  },

  onUnload() {
    this._isUnmounted = true;
    // 清理延迟返回定时器：用户提前手动返回时避免回调再 pop 一页
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
  },

  /**
   * 上传头像并把 loading 标题刷成真实百分比。
   * 真实运行时传 success/fail 回调会让 uploadFile 同步返回 UploadTask（onProgressUpdate）；
   * 部分 mock/旧环境只返回 Promise，此时退回 then/catch，两种形态都能落地。
   * 百分比取整数变化才刷新 showLoading，避免高频重绘。
   */
  _uploadWithProgress(cloudPath, filePath) {
    return new Promise((resolve, reject) => {
      const task = wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: resolve,
        fail: reject
      });
      if (task && typeof task.onProgressUpdate === 'function') {
        let lastPercent = -1;
        task.onProgressUpdate((p) => {
          const percent = Math.max(0, Math.min(100, Math.round(p.progress || 0)));
          if (percent !== lastPercent) {
            lastPercent = percent;
            wx.showLoading({ title: `上传中 ${percent}%`, mask: true });
          }
        });
      } else if (task && typeof task.then === 'function') {
        task.then(resolve).catch(reject);
      }
    });
  },

  /**
   * 删掉已上传但没能入库的云存储文件
   *
   * 为什么需要：上传与写库是两步，图片内容安全检测在**写库时**才由云函数执行。
   * 一旦检测不通过（或写库失败），文件已经在云存储里、库里却没有记录 —— 除了手工
   * 去控制台，没有任何入口能清掉它。失败路径上顺手删掉，避免累积垃圾与存储计费。
   * @param {string} fileID
   */
  async _cleanupUploadedFile(fileID) {
    if (!fileID) return;
    try {
      await wx.cloud.deleteFile({ fileList: [fileID] });
      Logger.info('add-cat', '已清理未入库的头像文件');
    } catch (err) {
      // 清理失败不影响主流程，留给控制台手工处理即可
      Logger.warn('add-cat', '清理未入库头像失败', { error: err.message });
    }
  }
});
