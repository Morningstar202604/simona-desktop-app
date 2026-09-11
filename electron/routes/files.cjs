/**
 * Files API Routes - 文件操作API（用于Code模式）
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

module.exports = function createFilesRouter(app, userDataPath) {
  const router = express.Router();

  // GET /api/files/tree - 获取文件树
  router.get('/tree', (req, res) => {
    try {
      const basePath = req.query.path || process.cwd();
      
      if (!fs.existsSync(basePath)) {
        return res.status(404).json({ error: 'Path not found' });
      }

      const tree = buildFileTree(basePath, basePath);
      res.json({ tree });
    } catch (error) {
      console.error('[Files] Failed to get file tree:', error);
      res.status(500).json({ error: 'Failed to get file tree' });
    }
  });

  // GET /api/files/read - 读取文件内容
  router.get('/read', (req, res) => {
    try {
      const filePath = req.query.path;

      if (!filePath) {
        return res.status(400).json({ error: 'path is required' });
      }

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
      }

      const content = fs.readFileSync(filePath, 'utf8');
      res.json({ content, path: filePath });
    } catch (error) {
      console.error('[Files] Failed to read file:', error);
      res.status(500).json({ error: 'Failed to read file' });
    }
  });

  // POST /api/files/write - 写入文件
  router.post('/write', (req, res) => {
    try {
      const { path: filePath, content } = req.body;

      if (!filePath || content === undefined) {
        return res.status(400).json({ error: 'path and content are required' });
      }

      // 确保目录存在
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, content, 'utf8');
      res.json({ success: true, path: filePath });
    } catch (error) {
      console.error('[Files] Failed to write file:', error);
      res.status(500).json({ error: 'Failed to write file' });
    }
  });

  // POST /api/terminal/exec - 执行终端命令
  router.post('/exec', (req, res) => {
    try {
      const { command, cwd } = req.body;

      if (!command) {
        return res.status(400).json({ error: 'command is required' });
      }

      const options = {
        cwd: cwd || process.cwd(),
        timeout: 30000,
        maxBuffer: 1024 * 1024 // 1MB
      };

      exec(command, options, (error, stdout, stderr) => {
        if (error) {
          res.json({
            output: stderr || error.message,
            exitCode: error.code || 1
          });
        } else {
          res.json({
            output: stdout,
            exitCode: 0
          });
        }
      });
    } catch (error) {
      console.error('[Terminal] Failed to execute command:', error);
      res.status(500).json({ error: 'Failed to execute command' });
    }
  });

  // GET /api/git/status - 获取Git状态
  router.get('/status', (req, res) => {
    try {
      const repoPath = req.query.path || process.cwd();

      if (!fs.existsSync(repoPath)) {
        return res.status(404).json({ error: 'Path not found' });
      }

      // 检查是否是Git仓库
      exec('git rev-parse --abbrev-ref HEAD', { cwd: repoPath }, (error, stdout) => {
        if (error) {
          return res.json({ isRepo: false });
        }

        const branch = stdout.trim();

        // 获取Git状态
        exec('git status --porcelain', { cwd: repoPath }, (err, statusOut) => {
          const modified = statusOut ? statusOut.trim().split('\n').filter(l => l.trim()).length : 0;

          res.json({
            isRepo: true,
            branch,
            modified
          });
        });
      });
    } catch (error) {
      console.error('[Git] Failed to get status:', error);
      res.status(500).json({ error: 'Failed to get git status' });
    }
  });

  // GET /api/workspace/default - 获取默认工作区路径
  router.get('/default', (req, res) => {
    try {
      const defaultPath = path.join(require('os').homedir(), 'Documents', 'Simona Desktop');
      
      if (!fs.existsSync(defaultPath)) {
        fs.mkdirSync(defaultPath, { recursive: true });
      }

      res.json({ path: defaultPath });
    } catch (error) {
      console.error('[Workspace] Failed to get default path:', error);
      res.status(500).json({ error: 'Failed to get workspace path' });
    }
  });

  return router;
};

// 递归构建文件树
function buildFileTree(dirPath, basePath, maxDepth = 3, currentDepth = 0) {
  if (currentDepth > maxDepth) {
    return [];
  }

  const items = [];
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // 跳过隐藏文件和node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        items.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children: buildFileTree(fullPath, basePath, maxDepth, currentDepth + 1)
        });
      } else {
        items.push({
          name: entry.name,
          path: fullPath,
          type: 'file'
        });
      }
    }
  } catch (error) {
    console.error(`[Files] Error reading directory ${dirPath}:`, error.message);
  }

  return items;
}
