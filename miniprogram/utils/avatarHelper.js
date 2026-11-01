/**
 * avatarHelper.js — 旧名转发层
 * 
 * 此文件仅为向后兼容转发，新代码请直接 require('./mediaHelper')
 * 
 * MediaHelper 已合并 avatarHelper + photoUtils 的全部功能：
 * - resolveCatAvatars()  — 解析猫咪头像临时 URL
 * - resolvePhotoUrls()   — 解析照片临时 URL
 * - getAvatarUrl()       — 获取头像优化 URL
 * - getThumbnailUrl()    — 获取缩略图 URL
 */
const MediaHelper = require('./mediaHelper');
module.exports = MediaHelper;
