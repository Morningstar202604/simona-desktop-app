import React, { useState, useEffect, useCallback } from 'react';
import { X, ChevronRight, Folder, HardDrive, ArrowLeft, Check } from 'lucide-react';

interface DirEntry {
  name: string;
  path: string;
  isDrive: boolean;
}

interface Props {
  onSelect: (path: string) => void;
  onClose: () => void;
}

const FolderBrowser: React.FC<Props> = ({ onSelect, onClose }) => {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const loadDirs = useCallback(async (dirPath: string) => {
    setLoading(true);
    try {
      const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
      const dirsUrl = '/api/workspace/dirs' + params;
      const res = await fetch(dirsUrl);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => 'unknown')}`);
      }
      const data = await res.json();
      if (data && Array.isArray(data.entries)) {
        setEntries(data.entries);
        setParentPath(data.parentPath !== undefined ? data.parentPath : null);
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      console.error('[FolderBrowser] Failed to load dirs:', err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDirs('');
  }, [loadDirs]);

  const navigateTo = (dirPath: string) => {
    setCurrentPath(dirPath);
    loadDirs(dirPath);
  };

  const goBack = () => {
    if (parentPath !== null) {
      setCurrentPath(parentPath);
      loadDirs(parentPath);
    }
  };

  const handleSelect = (entry: DirEntry) => {
    if (entry.isDrive) {
      navigateTo(entry.path);
    } else {
      navigateTo(entry.path);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-simona-input border border-simona-border rounded-2xl shadow-xl overflow-hidden w-[480px] max-w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-simona-border">
          <div className="flex items-center gap-2 min-w-0">
            {currentPath && (
              <button
                onClick={goBack}
                className="p-1.5 hover:bg-simona-hover rounded-lg transition-colors flex-shrink-0"
                title="返回上一级"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <h3 className="text-[16px] font-semibold text-simona-text truncate">
              {currentPath || '选择工作区文件夹'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-simona-hover rounded-lg transition-colors flex-shrink-0 ml-2"
          >
            <X size={18} />
          </button>
        </div>

        {currentPath && (
          <div className="px-5 py-2 border-b border-simona-border bg-simona-bg/50">
            <p className="text-[13px] text-simona-textSecondary truncate">{currentPath}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 min-h-[200px]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-[#5B9BFF] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-simona-textSecondary">
              <Folder size={32} className="mb-2 opacity-30" />
              <p className="text-[14px]">此目录下没有文件夹</p>
            </div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => handleSelect(entry)}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-simona-hover rounded-lg transition-colors text-left group"
              >
                {entry.isDrive ? (
                  <HardDrive size={18} className="text-[#5B9BFF] flex-shrink-0" />
                ) : (
                  <Folder size={18} className="text-[#d4a84b] flex-shrink-0" />
                )}
                <span className="text-[14px] text-simona-text flex-1 truncate">{entry.name}</span>
                <ChevronRight size={14} className="text-simona-textSecondary opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
              </button>
            ))
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-simona-border bg-simona-bg/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[13px] text-simona-textSecondary hover:text-simona-text bg-simona-input border border-simona-border rounded-lg hover:bg-simona-hover transition-colors"
          >
            取消
          </button>
          {currentPath && (
            <button
              onClick={() => {
                onSelect(currentPath);
                onClose();
              }}
              className="px-4 py-2 text-[13px] font-medium text-white bg-[#5B9BFF] hover:bg-[#4A8AE6] rounded-lg transition-colors flex items-center gap-1.5"
            >
              <Check size={14} />
              选择此文件夹
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default FolderBrowser;
