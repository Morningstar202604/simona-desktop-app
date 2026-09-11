/**
 * Code Mode Component - 代码模式主界面（简化版）
 */

import React, { useState, useEffect } from 'react';

const CodeMode: React.FC = () => {
  const [workspacePath, setWorkspacePath] = useState<string>('');
  const [files, setFiles] = useState<any[]>([]);

  useEffect(() => {
    initializeWorkspace();
  }, []);

  const initializeWorkspace = async () => {
    try {
      const response = await fetch('/api/workspace/default');
      if (response.ok) {
        const data = await response.json();
        setWorkspacePath(data.path);
        loadFileTree(data.path);
      }
    } catch (error) {
      console.error('[Code] Failed to initialize workspace:', error);
    }
  };

  const loadFileTree = async (path: string) => {
    try {
      const response = await fetch(`/api/files/tree?path=${encodeURIComponent(path)}`);
      if (response.ok) {
        const data = await response.json();
        setFiles(data.tree || []);
      }
    } catch (error) {
      console.error('[Code] Failed to load file tree:', error);
    }
  };

  return (
    <div className="flex flex-col h-full bg-simona-bg">
      <div className="flex items-center justify-between px-6 py-3 border-b border-simona-border bg-simona-headerBg">
        <div className="flex items-center gap-4">
          <span className="text-sm text-simona-textSecondary truncate max-w-md">
            {workspacePath}
          </span>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-64 border-r border-simona-border bg-simona-sidebarBg overflow-auto p-3">
          <h3 className="text-sm font-medium text-simona-text mb-2">文件浏览器</h3>
          {files.length === 0 ? (
            <p className="text-sm text-simona-textSecondary">暂无文件</p>
          ) : (
            <div className="space-y-1">
              {files.slice(0, 20).map((file) => (
                <div
                  key={file.path}
                  className="flex items-center gap-2 px-2 py-1 hover:bg-simona-hover rounded cursor-pointer text-sm text-simona-text"
                >
                  <span>{file.type === 'directory' ? '📁' : '📄'}</span>
                  <span className="truncate">{file.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 flex items-center justify-center text-simona-textSecondary">
          <p>选择一个文件开始编辑</p>
        </div>
      </div>
    </div>
  );
};

export default CodeMode;
