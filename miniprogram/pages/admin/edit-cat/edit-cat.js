/**
 * pages/admin/edit-cat/edit-cat.js - 编辑猫咪页面
 * 
 * 职责：
 * 1. 加载猫咪信息
 * 2. 编辑表单
 * 3. 保存修改
 */
const { requireAdminAuth } = require('../../../utils/adminAuth');

const ErrorHandler = require('../../../utils/errorHandler');
const { Logger } = require('../../../utils/logger');

const { getPageStateManager } = require('../../../utils/pageState');

const obsHelper = require('../../../utils/obsHelper');
// 选图必须经兼容层：PC 端不支持 wx.chooseMedia，直调会静默无响应
const { pickImages } = require('../utils/mediaChoose');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');
// 与 add-cat 同一口径：头像必须先压到 1M 以内，否则云函数 imgSecCheck 会直接拒绝
const { compressToLimit } = require('../utils/imageCompressor');
const config = require('../../../config');


Page({
  behaviors: [adminBehavior, safeSetDataBehavior],
  // ========== 生命周期 ==========

  async onLoad(options) {
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败**保持 loading=true**（骨架屏常驻）并在 1.5s 后自动返回，
      // 口径同 meet-rank / fav-rank / admin.js。
      // 过去这里多了一句 loading:false，等于在鉴权窗口里把一个**完全空的表单**
      // 亮给用户：所有字段空白、可点、可输入，提交必然失败。
      // 骨架屏至少诚实地表达「还没准备好」。
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return;
    }
    if (!this.guardPermission('cat', '猫咪管理')) return;

    const windowInfo = wx.getWindowInfo();
    this.safeSetData({ statusBarHeight: windowInfo.statusBarHeight || 0 });

    const catId = options.id || options.catId;
    if (!catId) {
      wx.showToast({ title: '缺少猫咪信息', icon: 'none' });
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return;
    }
    this.safeSetData({ catId });
    this.loadCat(catId);
  },

  onUnload() {
    // 清理延迟返回定时器 + 解除卸载保护标记
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
    this._markUnmounted();
  },


  data: {
    statusBarHeight: 0,
    catId: '',
    loading: true,
    saving: false,
    avatar: null,
    newAvatar: null,
    inputFocus: false,
    // 同 add-cat：长度上限从 config.security 注入，wxml 硬编码 200 与服务端 500 不一致
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
      // 好猫星级（0 = 不评；3/4/5 = 星级），加载时按猫咪当前值回填
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

  // ========== 数据加载 ==========

  /**
   * 加载猫咪信息（通过云函数）
   */
  async loadCat() {
    try {
      const res = await this.callAdminFunction('getShareData', { catId: this.data.catId });

      if (!res.result?.success) {
        throw new Error(res.result?.error || '加载失败');
      }

      const cat = res.result?.data?.cat;
      if (!cat) {
        throw new Error('猫咪不存在');
      }

      this.safeSetData({
        loading: false,
        avatar: cat.avatar || null,
        form: {
          name: cat.name || '',
          gender: cat.gender || '',
          age: cat.age || '成年',
          color: cat.color || '',
          sterilized: cat.sterilized !== undefined ? cat.sterilized : null,
          location: cat.location || '',
          campus: cat.campus || '',
          status: cat.status || 'normal',
          // 好猫星级：旧文档没有该字段时回填 0（不评）
          adoptLevel: Number(cat.adoptLevel) || 0,
          deceasedTime: cat.deceasedTime || '',
          deceasedReason: cat.deceasedReason || '',
          lostTime: cat.lostTime || '',
          lostLocation: cat.lostLocation || '',
          description: cat.description || '',
          appearance: cat.appearance || '',
          notes: cat.notes || '',
          healthStatus: cat.healthStatus || 'healthy',
          healthNote: cat.healthNote || ''
        }
      });

      wx.setNavigationBarTitle({ title: `编辑 · ${cat.name || '猫咪'}` });
    } catch (err) {
      this.safeSetData({ loading: false });
      ErrorHandler.handle(err, { title: '加载失败' });
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
    }
  },

  // ========== 表单输入 ==========

  /**
   * 文本输入
   */
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  /**
   * 输入框获得焦点
   */
  onInputFocus() {
    this.setData({ inputFocus: true });
  },

  /**
   * 输入框失去焦点
   */
  onInputBlur() {
    this.setData({ inputFocus: false });
  },

  /**
   * 选项选择
   */
  onOption(e) {
    const { field, value } = e.currentTarget.dataset;
    this.setData({ [`form.${field}`]: value });
  },

  /**
   * 绝育状态
   */
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

  /**
   * 日期选择
   */
  onDate(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  // ========== 操作 ==========

  /**
   * 选择大头照
   */
  async onChooseAvatar() {
    // 防重入：选择过程中连点会叠开多个选择器
    if (this._choosingAvatar) return;
    this._choosingAvatar = true;

    try {
      const res = await pickImages({ count: 1 });
      if (res.ok) {
        this.setData({ newAvatar: res.files[0].tempFilePath });
      } else if (!res.cancelled) {
        ErrorHandler.handle(new Error(res.error && res.error.errMsg || '选择图片失败'), {
          title: '选择图片失败'
        });
      }
    } finally {
      this._choosingAvatar = false;
    }
  },

  /**
   * 移除大头照
   */
  onRemoveAvatar() {
    this.setData({ newAvatar: null });
  },

  /**
   * 取消
   */
  onCancel() {
    wx.navigateBack();
  },

  /**
   * 保存
   */
  async onSave() {
    const { form, catId, saving } = this.data;
    if (saving || this._saving) return;
    this._saving = true;

    const isAdmin = await this.verifyAdmin();
    if (!isAdmin) {
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

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中…', mask: true });

    // 记录本次新上传的头像：失败时删掉它，成功时删掉被替换的旧头像。
    // 两者都需要，否则要么留下孤儿文件，要么误删正在使用的头像。
    let uploadedAvatar = null;
    // updateCat 是否已发起：发起后 reject（超时/断网）属**歧义失败** ——
    // 服务端可能已写入新头像，此时删文件会把头像变成坏图（孤儿文件只是不可见垃圾）
    let updateAttempted = false;

    try {
      const updateData = {
        name: form.name.trim(),
        gender: form.gender,
        age: form.age,
        sterilized: form.sterilized,
        color: form.color?.trim() || '',
        location: form.location?.trim() || '',
        campus: form.campus || '',
        status: form.status,
        // 好猫星级：0/3/4/5；清空评级时下发 0。与加载值相同的 0 会在服务端
        // diff 中等价忽略（changeSummary.isSameValue），不会产生假变更日志
        adoptLevel: form.adoptLevel || 0,
        deceasedTime: form.deceasedTime || '',
        deceasedReason: form.deceasedReason?.trim() || '',
        lostTime: form.lostTime || '',
        lostLocation: form.lostLocation?.trim() || '',
        description: form.description?.trim() || '',
        appearance: form.appearance?.trim() || '',
        notes: form.notes?.trim() || '',
        healthStatus: form.healthStatus || 'healthy',
        healthNote: form.healthNote?.trim() || ''
      };

      // 如果有新头像，先压缩再上传
      if (this.data.newAvatar) {
        wx.showLoading({ title: '压缩中…', mask: true });
        // 与云函数 contentSecurity.IMAGE_MAX_BYTES 对齐，留 100KB 余量
        const compressed = await compressToLimit(this.data.newAvatar, 950 * 1024);
        if (!compressed.withinLimit) {
          wx.hideLoading();
          ErrorHandler.handle(new Error('图片过大，压缩后仍超过 1M，请换一张尺寸更小的照片'), {
            title: '图片过大'
          });
          return;
        }

        wx.showLoading({ title: '上传头像…', mask: true });
        const extMatch = compressed.path.match(/\.(\w+)$/);
        const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
        const safeExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg';
        const cloudPath = `cats/avatar/${Date.now()}_${Math.random().toString(36).slice(2, 11)}.${safeExt}`;
        const uploadRes = await wx.cloud.uploadFile({ cloudPath, filePath: compressed.path });
        if (!uploadRes || !uploadRes.fileID) {
          throw new Error('头像上传失败');
        }
        uploadedAvatar = uploadRes.fileID;
        updateData.avatar = uploadedAvatar;
        wx.showLoading({ title: '保存中…', mask: true });
      }

      // 通过云函数更新（服务端验证权限）
      updateAttempted = true;
      const updateRes = await this.callAdminFunction('updateCat', { catId, updateData });

      wx.hideLoading();

      if (updateRes.result?.success) {
        const previousAvatar = this.data.avatar;
        // 新头像已生效，旧头像再无人引用 → 回收，避免云存储持续累积
        if (uploadedAvatar && previousAvatar && previousAvatar !== uploadedAvatar) {
          this._cleanupCloudFile(previousAvatar);
        }
        // 页面已卸载（用户保存期间退出）：不再弹提示/排返回 —— 否则定时器在卸载后才赋值，
        // onUnload 清不到，1.2s 后会对用户当前所在页面多 pop 一级
        if (this._isUnmounted) return;
        // 同步页面状态：不清 newAvatar 的话，返回窗口内二次保存会再次上传同一张图，
        // 并把第一次上传的新头像变成孤儿（对比用的还是已删除的旧头像）
        this.safeSetData({
          avatar: uploadedAvatar || previousAvatar,
          newAvatar: ''
        });
        // 保持提交锁直到跳转，防窗口期内二次提交
        this._savedOk = true;
        ErrorHandler.showSuccess('保存成功');

        obsHelper.reportEvent(obsHelper.EVENT_NAMES.ADMIN_EDIT_CAT, {
          cat_id: catId.substring(0, 8)
        });

        getPageStateManager().setNeedRefresh('index', { catId, action: 'update' });
        getPageStateManager().setNeedRefresh('detail', { catId, action: 'update' });
        // 猫咪管理列表也要刷新：它只按 20s 时间守卫决定重载，
        // 「改名/换头像后立即返回」会看到旧数据；换头像后旧文件已删还会裂图
        getPageStateManager().setNeedRefresh('cat-manage', { catId, action: 'update' });
        this._navBackTimer = setTimeout(() => this.goBack(), 1200);
      } else {
        // 更新未生效（内容安全拦截等）：新头像没有入库，删掉它
        if (uploadedAvatar) this._cleanupCloudFile(uploadedAvatar);
        ErrorHandler.handle(new Error(updateRes.result?.error || '保存失败'), { title: '保存失败' });
      }

    } catch (err) {
      wx.hideLoading();
      // 未发起 updateCat（压缩/上传阶段异常）⇒ 必然未入库，可安全回收；
      // 已发起后 reject（超时/断网）结果未知 —— 宁留孤儿不毁引用
      if (uploadedAvatar && !updateAttempted) this._cleanupCloudFile(uploadedAvatar);
      ErrorHandler.handle(err, { title: '保存失败' });
    } finally {
      // 成功路径保持锁与 saving（按钮不可用直到跳转，防二次提交）；失败路径复位
      if (!this._savedOk) {
        this.safeSetData({ saving: false });
        this._saving = false;
      }
    }
  },

  /**
   * 回收云存储文件（尽力而为，失败不影响主流程）
   * @param {string} fileID
   */
  async _cleanupCloudFile(fileID) {
    if (!fileID || typeof fileID !== 'string' || !fileID.startsWith('cloud://')) return;
    try {
      await wx.cloud.deleteFile({ fileList: [fileID] });
      Logger.info('edit-cat', '已回收云存储文件');
    } catch (err) {
      Logger.warn('edit-cat', '回收云存储文件失败', { error: err.message });
    }
  }
});
