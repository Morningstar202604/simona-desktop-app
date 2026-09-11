const fs = require('fs');
const path = require('path');

const releaseDir = path.join(__dirname, '..', 'release', 'win-unpacked', 'resources');
const unpackedDir = path.join(releaseDir, 'app.asar.unpacked', 'node_modules');

// 要删除的平台目录
const platformDirs = ['@napi-rs', '@img', '@mariozechner', '@lydell'];

function deleteDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Deleted:', dir.replace(releaseDir + '\\', ''));
  }
}

function processDir(parent) {
  if (!fs.existsSync(parent)) return;
  
  const items = fs.readdirSync(parent, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(parent, item.name);
    
    if (item.isDirectory()) {
      // @napi-rs 只保留 win32-x64
      if (item.name === '@napi-rs') {
        const napiDirs = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const sub of napiDirs) {
          if (sub.isDirectory() && !sub.name.includes('win32-x64')) {
            deleteDir(path.join(fullPath, sub.name));
          }
        }
      } 
      // 其他平台目录（非 win32-x64），删除
      else if (platformDirs.includes(item.name)) {
        deleteDir(fullPath);
      }
      else {
        processDir(fullPath);
      }
    }
  }
}

console.log('Trimming native modules for Windows x64 only...');
processDir(unpackedDir);
console.log('Done!');
