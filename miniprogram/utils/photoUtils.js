// utils/photoUtils.js - 照片 URL 解析工具（转调 MediaHelper）
const MediaHelper = require('./mediaHelper');
module.exports = { resolvePhotoUrls: (photos, options) => MediaHelper.resolvePhotoUrls(photos, options) };
