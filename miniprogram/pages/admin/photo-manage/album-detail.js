/**
 * 相册详情 - 照片管理（上传/删除）
 */
const { requireAdminAuth } = require('../../../utils/adminAuth');

const imageLoader = require('../../../utils/imageLoader');

const { Logger } = require('../../../utils/logger');

const { compressToLimit } = require('../utils/imageCompressor');

const ErrorHandler = require('../../../utils/errorHandler');

const { formatDateShort } = require('../../../utils/dateFormat');

const backToTopBehavior = require('../../../behaviors/backToTopBehavior');

const { getPageStateManager } = require('../../../utils/pageState');

// 选图必须经兼容层：PC 端不支持 wx.chooseMedia，直调会静默无响应
const { pickImages } = require('../utils/mediaChoose');

const obsHelper = require('../../../utils/obsHelper');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');


Page({
  behaviors: [backToTopBehavior, adminBehavior, safeSetDataBehavior],
  data: {
    statusBarHeight: 0,
    catId: '',
    catName: '',
    photos: [],
    // 同 photo-manage.js:26：初值必须 true，否则 onLoad 的 await requireAdminAuth()
    // 期间 wxml:70 的 !loading 分支会渲染空态，闪现一帧「还没有照片」
    loading: true,
    loadingMore: false,
    hasMore: true,
    pageSize: 20,
    page: 0,
    uploading: false,
    uploadProgress: 0,
    uploadCurrent: 0,
    uploadTotal: 0,
    uploadFileName: '',
    uploadStage: '',
    showBackToTop: false,
    skeletonItems: [1, 2, 3, 4, 5, 6]
  },

  async onLoad(options) {
    this._backToTopThreshold = 400;
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能只 return：loading 初值为 true → 骨架屏常驻（同 admin.js 口径）
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      this.safeSetData({ loading: false });
      return;
    }
    if (!this.guardPermission('photo', '照片管理')) {
      this.safeSetData({ loading: false });
      return;
    }

    // 入口已由 guardPermission('photo') 把关：能进本页即具备「照片管理」权限，
    // 页内删除不再按角色隐藏（普通管理员被开通入口后同样可以删）。
    this.safeSetData({
      statusBarHeight: wx.getWindowInfo().statusBarHeight || 0,
      catId: options.catId || '',
      catName: options.catName ? decodeURIComponent(options.catName) : ''
    });

    await this.loadPhotos();
  },

  onShow() {
    // 必须区分「从未加载」与「加载过但本来就没照片」：只看 photos.length === 0
    // 会让空相册每次 onShow 都重发一次 getPhotosByCat（从预览返回、传完照片回来都会触发）。
    // _loadedOnce 由 loadPhotos 成功后置位，失败不置位（保留重试入口）。
    if (this.data.catId && !this._loadedOnce) {
      this.loadPhotos();
    }
  },

  onBack() {
    wx.navigateBack();
  },

  async onPreviewPhoto(e) {
    const photo = e.currentTarget.dataset.photo;

    // 网格里展示的是 thumbnail(200px) 档，直接拿去全屏预览会被拉伸成马赛克。
    // 预览必须按 detail(600px) 档重新换链；换链按「fileID@档位」缓存，
    // 重复点开同一张不会重复请求，也不会冲掉网格的 thumbnail 缓存。
    const fileID = photo?._cloudFileID || (photo?.url?.startsWith('cloud://') ? photo.url : '');

    if (fileID) {
      const detailUrl = await imageLoader.getTempUrl(fileID, { optimizeType: 'detail' });
      if (detailUrl) {
        wx.previewImage({ urls: [detailUrl], current: detailUrl });
        return;
      }
    }

    // 兜底：拿不到云文件ID或换链失败时，退回列表已解析的链接（可能是缩略图）
    const url = photo?.tempUrl || photo?.url || '';
    if (!url || url.startsWith('cloud://')) {
      wx.showToast({ title: '图片加载中，请稍后再试', icon: 'none' });
      return;
    }
    wx.previewImage({ urls: [url], current: url });
  },

  async loadPhotos() {
    if (!this.data.catId) return;
    // 守卫必须用**实例字段**判「请求在途」，不能拿 data.loading：
    // data.loading 初值为 true 是**展示状态**（骨架屏常驻，避免鉴权期间闪「暂无照片」，
    // 见 data.loading 处注释）。二者曾被混为一谈，后果是 onLoad 里
    // `await this.loadPhotos()` 在鉴权通过后立刻撞上 `if (this.data.loading) return`
    // → 首次加载早退、_loadedOnce 永不置位、onShow 再调又早退 →
    // 整页永久骨架屏、一次 getPhotosByCat 都没发出去（表现为「点进相册什么都没有」）。
    if (this._photosLoading || this.data.loadingMore) return;
    this._photosLoading = true;

    const isFirstLoad = this.data.page === 0 && this.data.photos.length === 0;
    if (isFirstLoad) {
      this.setData({ loading: true });
    } else {
      this.setData({ loadingMore: true });
    }

    try {
      const page = this.data.page + 1; // getPhotosByCat 页码从1开始
      Logger.info('album-detail', '查询照片', { catId: this.data.catId, page });

      const res = await this.callAdminFunction('getPhotosByCat', {
        catId: this.data.catId,
        page,
        pageSize: this.data.pageSize
      });

      if (!res.result?.success) {
        throw new Error(res.result?.error || '加载失败');
      }

      const data = res.result?.data ?? res.result ?? {};
      const newPhotos = data.photos || [];
      await this.resolveUrls(newPhotos);

      // 追加按 _id 去重（同 photo-manage.js:121 / relation-manage.js:136 口径）：
      // 上传成功后重置 + 触底加载并发时，skip/limit 偏移窗口会让边界照片重复
      const photos = page === 1
        ? newPhotos
        : [...this.data.photos, ...newPhotos.filter(p => !this.data.photos.some(x => x._id === p._id))];
      const hasMore = data.hasMore || false;

      // 首屏加载成功即置位：让 onShow 能区分「空相册」与「尚未加载」。
      // 失败路径不置位，因此首屏失败后重进页面仍会重试。
      if (page === 1) this._loadedOnce = true;

      this.safeSetData({ photos, hasMore, page: this.data.page + 1 });
    } catch (err) {
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      this._photosLoading = false;
      this.safeSetData({ loading: false, loadingMore: false });
    }
  },

  onLoadMore() {
    // 只判「请求在途」：data.loading 是展示状态（初值 true = 骨架屏常驻），
    // 拿它当上拉加载的准入条件会让触底永远不生效（同 loadPhotos 守卫的教训）。
    if (this.data.hasMore && !this._photosLoading && !this.data.loadingMore) {
      this.loadPhotos();
    }
  },

  onReachBottom() {
    this.onLoadMore();
  },

  async resolveUrls(photos) {
    const fileIDs = photos
      .map(p => p.url)
      .filter(url => url && url.startsWith('cloud://'));

    photos.forEach(p => {
      if (p.createTime) {
        p.formatDate = formatDateShort(p.createTime);
      }
    });

    if (fileIDs.length === 0) return;

    try {
      const urlMap = await imageLoader.getTempUrls(fileIDs, { optimizeType: 'thumbnail' });

      photos.forEach(p => {
        if (p.url && urlMap[p.url]) {
          p.tempUrl = urlMap[p.url];
          p._cloudFileID = p.url;
        }
      });

      Logger.info('album-detail', '照片URL转换完成', { count: fileIDs.length });
    } catch (err) {
      Logger.error('album-detail', '照片临时链接获取失败', err);
    }
  },

  async onUploadPhoto() {
    // 进门守卫：上传进行中禁止重入。verifyAdmin/chooseMedia 都是异步的，
    // 只靠 data.uploading 拦不住两次快速点击，故用实例标记在入口同步置位。
    if (this._uploading) {
      wx.showToast({ title: '正在上传中，请稍候', icon: 'none' });
      return;
    }
    this._uploading = true;

    const isAdmin = await this.verifyAdmin();
    if (!isAdmin) {
      this._uploading = false;
      wx.showToast({ title: '权限不足', icon: 'none' });
      return;
    }

    try {
      // PC 端不支持 wx.chooseMedia，必须经兼容层降级到 chooseImage，否则点击无任何反应
      const res = await pickImages({ count: 9 });
      if (!res.ok) {
        this._uploading = false;
        if (!res.cancelled) {
          wx.showToast({
            title: res.error && res.error.errMsg || '选择图片失败',
            icon: 'none'
          });
        }
        return;
      }
      const files = res.files;
      const total = files.length;

      // 新一轮上传：清除上一轮遗留的取消标记
      this._uploadCancelled = false;

      this.setData({
        uploading: true,
        uploadProgress: 0,
        uploadCurrent: 0,
        uploadTotal: total,
        uploadFileName: '',
        uploadStage: 'preparing'
      });

      let successCount = 0;

      for (let i = 0; i < files.length; i++) {
        // 用户已点「取消上传」：停止后续照片，已在库里的照片保持不动
        if (this._uploadCancelled) break;

        const file = files[i];
        const fileName = `照片 ${i + 1}/${total}`;
        // 本张照片已上传的 fileID（用于失败时回收孤儿文件）
        let uploadedFileID = '';
        // 服务端是否**明确拒绝**（success:false）：只有这种情况才能确定未入库、可安全回收；
        // 超时/断网 reject 属歧义失败（服务端可能已写入），删文件会把照片变成坏图
        let recordRejected = false;

        this.safeSetData({
          uploadCurrent: i + 1,
          uploadFileName: fileName,
          uploadProgress: 5,
          uploadStage: 'compressing'
        });

        try {
          // 与 add-cat / edit-cat 头像链路统一：压缩必须**校验字节数**。
          // smartCompress 只压尺寸/质量，1920px/q90 的手机照片常常仍 >1MB，
          // 而 addPhoto 服务端按 imgSecCheck 硬卡 1MB —— 文件已真实落云存储、
          // 随后必然被拒，管理员只能反复换小图。
          const PHOTO_MAX_BYTES = 950 * 1024;
          const compressed = await compressToLimit(file.tempFilePath, PHOTO_MAX_BYTES);
          if (!compressed.withinLimit) {
            throw new Error('图片过大（压缩后仍超过 1M），请换一张尺寸更小的照片');
          }
          const compressedPath = compressed.path;

          this.setData({
            uploadFileName: fileName + '（上传中…）',
            uploadProgress: Math.round(30 + i / files.length * 55),
            uploadStage: 'uploading'
          });

          const cloudPath = `photos/${this.data.catId}/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;

          const uploadRes = await wx.cloud.uploadFile({
            cloudPath,
            filePath: compressedPath
          });
          // 记录已上传文件：addPhoto 只在内容检测不通过时自行删文件，
          // 其余失败分支（猫咪不存在、网络中断等）需要客户端尽力回收
          uploadedFileID = uploadRes.fileID || '';

          this.safeSetData({
            uploadProgress: 90,
            uploadStage: 'saving'
          });

          const addRes = await this.callAdminFunction('addPhoto', {
            catId: this.data.catId,
            catName: this.data.catName,
            url: uploadRes.fileID
          });

          if (!addRes.result?.success) {
            // 后端 fail() 文案在 error 字段，message 恒为空串，两者兼容
            recordRejected = true;
            throw new Error(addRes.result?.error || '写入记录失败');
          }

          // 已入库：文件归照片记录所有，后续异常不得再回收
          uploadedFileID = '';

          this.setData({
            uploadProgress: 100,
            uploadStage: 'done'
          });

          successCount++;

        } catch (err) {
          // 仅当服务端明确拒绝（success:false）时回收 —— 此时记录必然未入库；
          // 超时/断网（reject）结果未知，服务端可能已写入，删文件会毁掉已入库的照片。
          // 服务端内容检测失败时已自行删除，重复删除幂等无害。
          if (uploadedFileID && recordRejected) {
            try {
              await wx.cloud.deleteFile({ fileList: [uploadedFileID] });
              Logger.info('album-detail', '已清理未入库的照片文件');
            } catch (cleanupErr) {
              Logger.warn('album-detail', '清理未入库照片失败', { error: cleanupErr.message });
            }
            uploadedFileID = '';
          }
          Logger.warn('album-detail', '上传照片失败', { error: err.message });
          // 直接 toast「第 N 张 + 原因」：ErrorHandler.handle 的 title 只在 error 为空时兜底，
          // 带 message 的 err 会走 getFriendlyMessage 把「第 N 张」吃掉（此前注释声称的修复未生效），
          // 管理员无法定位坏图。
          // 网络类异常的消息没有信息量（如 request:fail / cloud.callFunction:fail timeout），
          // 此时回退到「第 N 张上传失败」。注意 cloud 类错误是 `cloud.callFunction:fail`
          // （点号），不能只匹配 `cloud:`（那是 fileID 前缀），否则原始英文错误会直接弹给用户。
          const isTransportError = err && err.message && /^(request|cloud)[:.]/i.test(err.message);
          const detail = err && err.message && !isTransportError
            ? `第 ${i + 1} 张：${err.message}`
            : `第 ${i + 1} 张上传失败`;
          wx.showToast({ title: detail, icon: 'none', duration: 2500 });
        }
      }

      // 循环结束（正常跑完或被取消）：释放重入锁并复位进度UI
      this._uploading = false;
      const cancelled = this._uploadCancelled;

      // 卸载检查必须早于任何 setData：在已销毁页面上 setData 会抛「页面已销毁」，
      // 异常落入外层 catch 后会对已离开的用户弹「上传失败」（实际照片已入库）
      if (this._isUnmounted) return;

      this.safeSetData({
        uploading: false,
        uploadProgress: 0,
        uploadCurrent: 0,
        uploadTotal: 0,
        uploadFileName: ''
      });

      if (cancelled && successCount === 0) {
        // 取消时一张都没传成功：没有任何照片入库，无需刷新列表，
        // 也不要把用户的主动取消误报成「上传失败」
        ErrorHandler.showSuccess('已取消上传');
        return;
      }

      if (successCount === 0) {
        ErrorHandler.handle(new Error('全部上传失败'), { title: '上传失败' });
        return;
      }

      // 已上传成功的照片都已入库，取消时同样要刷新列表如实展示，不能隐藏
      ErrorHandler.showSuccess(cancelled
        ? `已取消上传，已完成 ${successCount} 张`
        : `成功上传 ${successCount} 张`);

      obsHelper.reportEvent(obsHelper.EVENT_NAMES.ADMIN_ADD_PHOTO, {
        photo_count: successCount,
        cat_id: this.data.catId.substring(0, 8)
      });

      // 重置必须同时清 photos：loadPhotos 的 isFirstLoad 判据是
      // `page===0 && photos.length===0`（:113），只重置 page 会让重载走
      // loadingMore 分支，期间旧网格与底部「加载中...」并存才整体替换。
      this.safeSetData({ page: 0, photos: [], hasMore: true });
      await this.loadPhotos();

      const pageState = getPageStateManager();
      pageState.setNeedRefresh('detail', {
        catId: this.data.catId,
        action: 'photo_added'
      });
      // 相册列表（photo-manage）消费的刷新标记：其 onShow 有 20s 时间守卫，
      // 不设标记的话上传后 20s 内返回列表仍是旧张数/旧封面，管理员会误以为上传失败
      pageState.setNeedRefresh('photo-manage', {
        catId: this.data.catId,
        action: 'photos_changed'
      });

    } catch (err) {
      this._uploading = false;

      // 必须走 safeSetData：safeSetDataBehavior 在 Page 场景下 lifetimes 钩子不生效，
      // 只有 _isUnmounted 标记拦得住已销毁页面上的 setData。
      // 上面的正常路径有 `if (this._isUnmounted) return;` 保护、且用 safeSetData，
      // 唯独这条异常路径两者都没有 —— 上传循环中抛异常且用户已返回上一页时，
      // 会在已销毁 Page 上直接 setData，部分基础库会抛「setData 页面已销毁」。
      this.safeSetData({
        uploading: false,
        uploadProgress: 0,
        uploadCurrent: 0,
        uploadTotal: 0,
        uploadFileName: ''
      });
      ErrorHandler.handle(err, { title: '上传失败' });
    }
  },

  async onCancelUpload() {
    const res = await wx.showModal({
      title: '确认取消',
      content: '确定要取消上传吗？已上传成功的照片会保留，未上传的将放弃。',
      confirmText: '确定取消',
      cancelText: '继续上传',
      confirmColor: getApp().globalData.theme === 'dark' ? '#F5A593' : '#E8927C'
    });

    if (!res.confirm) return;

    this._cleanupUploadResources();

    // 上传循环可能仍在跑：它会读取取消标记并在收尾处按实际成功张数提示，
    // 这里不再抢先提示，避免「已取消上传」与真实结果叠加造成误导。
    if (!this._uploading) {
      ErrorHandler.showSuccess('已取消上传');
    }
  },

  onDeletePhoto(e) {
    if (this._deleting) return;
    const photo = e.currentTarget.dataset.photo;
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这张照片吗？',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._deleting) return;
        this._deleting = true;

        const isAdmin = await this.verifyAdmin();
        if (!isAdmin) {
          this._deleting = false;
          wx.showToast({ title: '权限不足', icon: 'none' });
          return;
        }

        try {
          const callRes = await this.callAdminFunction('deleteData', { type: 'photo', id: photo._id });

          if (!callRes.result?.success) {
            ErrorHandler.handle(new Error(callRes.result?.error || '删除失败'), { title: '删除失败' });
            return;
          }

          ErrorHandler.showSuccess('已删除');
          // 重置分页游标并重拉：服务端是 offset 分页，删除会让后续 offset 前移一位，
          // 继续「加载更多」会漏掉一张；极端情况整页删空后剩余照片无法加载
          //（「加载更多」按钮被 photos.length > 0 条件隐藏）。
          // 重置必须同时清 photos：loadPhotos 的 isFirstLoad 判据是
          // `page===0 && photos.length===0`（:113），只重置 page 会让重载走
          // loadingMore 分支，期间旧网格与底部「加载中...」并存才整体替换。
          this.safeSetData({ page: 0, photos: [], hasMore: true });
          await this.loadPhotos();

          const pageState = getPageStateManager();
          pageState.setNeedRefresh('detail', {
            catId: this.data.catId,
            action: 'photo_deleted'
          });
          pageState.setNeedRefresh('photo-manage', {
            catId: this.data.catId,
            action: 'photos_changed'
          });
        } catch (err) {
          Logger.warn('album-detail', '删除照片失败', { error: err.message });
          ErrorHandler.handle(err, { title: '删除失败' });
        } finally {
          this._deleting = false;
        }
      }
    });
  },

  _cleanupUploadResources() {
    // 置取消标记：上传循环每轮开头检查，下一张起不再上传
    this._uploadCancelled = true;

    // 卸载检查必须早于任何 setData：onUnload:492 刚把 _isUnmounted 置 true 就会调到这里，
    // 在已销毁页面上裸 setData 会抛「页面已销毁」；onCancelUpload:416 则是
    // await showModal 之后调用，用户可能已在等待确认期间返回上一页。
    if (this._isUnmounted) return;

    this.setData({
      uploading: false,
      uploadProgress: 0,
      uploadCurrent: 0,
      uploadTotal: 0,
      uploadFileName: '',
      uploadStage: ''
    });
  },

  onUnload() {
    this._isUnmounted = true;
    // 清掉在途标记：否则「加载途中退出 → 再进同一实例」会被守卫一直挡着
    this._photosLoading = false;
    // 清理延迟返回定时器（门禁失败自动返回用）
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
    this._cleanupUploadResources();
  }
});
