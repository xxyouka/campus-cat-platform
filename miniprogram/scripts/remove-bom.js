// scripts/remove-bom.js - 移除源码文件中的 BOM 头
const fs = require('fs');
const path = require('path');

const targetDir = process.argv[2] || path.join(__dirname, '..');
const fileExtensions = ['.js', '.wxml', '.wxss', '.json'];

let filesChanged = 0;
let filesChecked = 0;

function hasBOM(buffer) {
  return buffer.length >= 3 && 
         buffer[0] === 0xEF && 
         buffer[1] === 0xBB && 
         buffer[2] === 0xBF;
}

function removeBOMFromFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (hasBOM(buffer)) {
      fs.writeFileSync(filePath, buffer.slice(3));
      console.log(`移除 BOM: ${path.relative(targetDir, filePath)}`);
      filesChanged++;
    }
  } catch (error) {
    console.error(`处理文件失败: ${filePath}`, error.message);
  }
}

function traverseDirectory(dir) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      const dirName = path.basename(item);
      if (dirName !== 'node_modules' && 
          dirName !== '.git' && 
          dirName !== 'miniprogram_npm' && 
          !dirName.startsWith('.')) {
        traverseDirectory(fullPath);
      }
    } else if (stat.isFile()) {
      const ext = path.extname(item).toLowerCase();
      if (fileExtensions.includes(ext)) {
        filesChecked++;
        removeBOMFromFile(fullPath);
      }
    }
  }
}

console.log('开始检查和移除 BOM...\n');
traverseDirectory(targetDir);
console.log(`\n 检查完成: 检查了 ${filesChecked} 个文件，修改了 ${filesChanged} 个文件`);
