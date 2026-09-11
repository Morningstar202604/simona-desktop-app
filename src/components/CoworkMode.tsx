/**
 * Cowork Mode Component - 协作模式（三栏布局）
 * 
 * 功能：
 * 1. 左侧：工程目录树
 * 2. 中间：文件内容编辑器/查看器
 * 3. 右侧：聊天界面
 * 4. 支持鼠标拖拽调整三栏宽度
 */

import React, { useState, useEffect, useRef } from 'react';
import MainContent from './MainContent';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

interface CoworkModeProps {
  conversationId?: string;
}

const CoworkMode: React.FC<CoworkModeProps> = ({ conversationId }) => {
  console.log('[Cowork] Component mounted, conversationId:', conversationId);
  
  // 三栏宽度状态（百分比）
  const [leftWidth, setLeftWidth] = useState(25);
  const [rightWidth, setRightWidth] = useState(35);
  
  // 文件树相关
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState<string>('');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  
  // 拖拽相关
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingLeft = useRef(false);
  const isDraggingRight = useRef(false);

  // 加载工作区文件树
  useEffect(() => {
    loadFileTree();
    
    // 每3秒刷新一次文件树，以检测变化
    const interval = setInterval(loadFileTree, 3000);
    return () => clearInterval(interval);
  }, [conversationId]);

  const loadFileTree = async () => {
    try {
      const baseUrl = 'http://127.0.0.1:30080';
      const url = conversationId 
        ? `${baseUrl}/api/workspace/files?conversation_id=${conversationId}`
        : `${baseUrl}/api/workspace/files`;
      console.log('[Cowork] Loading file tree from:', url);
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        console.log('[Cowork] File tree data:', data);
        setFileTree(data.files || []);
      } else {
        console.error('[Cowork] Failed to load file tree, status:', response.status);
      }
    } catch (error) {
      console.error('[Cowork] Failed to load file tree:', error);
    }
  };

  // 加载文件内容
  const loadFileContent = async (filePath: string) => {
    try {
      const baseUrl = 'http://127.0.0.1:30080';
      const url = conversationId
        ? `${baseUrl}/api/workspace/file?path=${encodeURIComponent(filePath)}&conversation_id=${conversationId}`
        : `${baseUrl}/api/workspace/file?path=${encodeURIComponent(filePath)}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setFileContent(data.content || '');
        setEditContent(data.content || '');
        setIsEditing(false);
      }
    } catch (error) {
      console.error('[Cowork] Failed to load file content:', error);
    }
  };

  // 处理文件点击
  const handleFileClick = (file: FileNode) => {
    if (file.type === 'directory') {
      toggleDirectory(file.path);
    } else {
      setSelectedFile(file.path);
      loadFileContent(file.path);
    }
  };

  // 保存文件
  const handleSaveFile = async () => {
    if (!selectedFile) return;
    
    try {
      const baseUrl = 'http://127.0.0.1:30080';
      const url = `${baseUrl}/api/workspace/file`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: selectedFile,
          content: editContent,
          conversation_id: conversationId
        })
      });
      
      if (response.ok) {
        setFileContent(editContent);
        setIsEditing(false);
        alert('文件已保存');
      } else {
        const error = await response.json();
        alert(`保存失败: ${error.error}`);
      }
    } catch (error) {
      console.error('[Cowork] Failed to save file:', error);
      alert('保存失败');
    }
  };

  // 切换目录展开/折叠
  const toggleDirectory = (dirPath: string) => {
    setExpandedDirs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(dirPath)) {
        newSet.delete(dirPath);
      } else {
        newSet.add(dirPath);
      }
      return newSet;
    });
  };

  // 渲染文件树节点
  const renderFileTree = (nodes: FileNode[], level: number = 0) => {
    return nodes.map((node, index) => (
      <div key={`${node.path}-${index}`}>
        <div
          className={`flex items-center py-1 px-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${
            selectedFile === node.path ? 'bg-blue-50 dark:bg-blue-900/20' : ''
          }`}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          onClick={() => handleFileClick(node)}
        >
          <span className="mr-2 text-sm">
            {node.type === 'directory' ? (
              expandedDirs.has(node.path) ? '📂' : '📁'
            ) : (
              getFileIcon(node.name)
            )}
          </span>
          <span className="text-sm text-gray-700 dark:text-gray-300 truncate">{node.name}</span>
        </div>
        
        {node.type === 'directory' && expandedDirs.has(node.path) && node.children && (
          <div>{renderFileTree(node.children, level + 1)}</div>
        )}
      </div>
    ));
  };

  // 获取文件图标
  const getFileIcon = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    const icons: Record<string, string> = {
      js: '📄', jsx: '⚛️', ts: '📘', tsx: '⚛️',
      py: '🐍', java: '☕', cpp: '⚙️', c: '⚙️',
      html: '🌐', css: '🎨', json: '📋', md: '📝',
      txt: '📄', log: '📋', yml: '⚙️', yaml: '⚙️',
    };
    return icons[ext || ''] || '📄';
  };

  // 拖拽处理
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;

      if (isDraggingLeft.current) {
        const newLeftWidth = ((e.clientX - containerRect.left) / containerWidth) * 100;
        if (newLeftWidth >= 15 && newLeftWidth <= 50) {
          setLeftWidth(newLeftWidth);
        }
      }

      if (isDraggingRight.current) {
        const newRightWidth = ((containerRect.right - e.clientX) / containerWidth) * 100;
        if (newRightWidth >= 25 && newRightWidth <= 60) {
          setRightWidth(newRightWidth);
        }
      }
    };

    const handleMouseUp = () => {
      isDraggingLeft.current = false;
      isDraggingRight.current = false;
      document.body.style.cursor = 'default';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const middleWidth = 100 - leftWidth - rightWidth;

  return (
    <div ref={containerRef} className="h-full flex bg-white dark:bg-gray-900 overflow-hidden">
      {/* 左侧：文件树 */}
      <div 
        className="border-r border-gray-200 dark:border-gray-700 overflow-y-auto bg-gray-50 dark:bg-gray-800"
        style={{ width: `${leftWidth}%` }}
      >
        <div className="p-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">工程目录</h3>
        </div>
        <div className="py-2">
          {fileTree.length > 0 ? (
            renderFileTree(fileTree)
          ) : (
            <div className="px-4 py-8 text-center text-gray-400 text-sm">
              暂无文件
            </div>
          )}
        </div>
      </div>

      {/* 左侧拖拽条 */}
      <div
        className="w-1 bg-gray-300 dark:bg-gray-600 hover:bg-blue-500 cursor-col-resize transition-colors"
        onMouseDown={(e) => {
          e.preventDefault();
          isDraggingLeft.current = true;
          document.body.style.cursor = 'col-resize';
        }}
      />

      {/* 中间：文件内容 */}
      <div 
        className="overflow-y-auto bg-white dark:bg-gray-900"
        style={{ width: `${middleWidth}%` }}
      >
        {selectedFile ? (
          <div className="h-full flex flex-col">
            <div className="p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                  {selectedFile.split('/').pop()}
                </span>
                <button
                  onClick={handleSaveFile}
                  className="px-3 py-1 text-xs bg-green-500 hover:bg-green-600 text-white rounded transition-colors"
                >
                  保存
                </button>
              </div>
            </div>
            <div className="flex-1 p-4 overflow-auto">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full h-full p-2 text-sm text-gray-800 dark:text-gray-200 font-mono bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded resize-none focus:outline-none focus:border-blue-500"
                style={{ minHeight: '400px' }}
              />
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-gray-400">
            <div className="text-center">
              <div className="text-4xl mb-2">📄</div>
              <div className="text-sm">选择一个文件查看内容</div>
            </div>
          </div>
        )}
      </div>

      {/* 右侧拖拽条 */}
      <div
        className="w-1 bg-gray-300 dark:bg-gray-600 hover:bg-blue-500 cursor-col-resize transition-colors"
        onMouseDown={(e) => {
          e.preventDefault();
          isDraggingRight.current = true;
          document.body.style.cursor = 'col-resize';
        }}
      />

      {/* 右侧：聊天界面 */}
      <div 
        className="border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
        style={{ width: `${rightWidth}%` }}
      >
        <MainContent onNewChat={() => {}} />
      </div>
    </div>
  );
};

export default CoworkMode;
