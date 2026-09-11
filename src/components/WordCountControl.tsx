import React, { useState, useEffect } from 'react';
import { Type, X } from 'lucide-react';

const WordCountControl: React.FC = () => {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const [isVisible, setIsVisible] = useState(() => {
    const saved = localStorage.getItem('show_word_count');
    if (saved !== null) return saved === 'true';
    return !isMobile; // 手机端默认隐藏
  });
  const [wordCount, setWordCount] = useState<number | null>(null);
  const [customCount, setCustomCount] = useState<string>('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [isPanelVisible, setIsPanelVisible] = useState(false);

  // 从 localStorage 加载设置
  useEffect(() => {
    const saved = localStorage.getItem('word_count_preset');
    if (saved) {
      try {
        setWordCount(parseInt(saved));
      } catch (e) {
        console.error('Failed to load word count:', e);
      }
    }
  }, []);

  // 监听设置变化
  useEffect(() => {
    const handleVisibilityChange = () => {
      const saved = localStorage.getItem('show_word_count');
      setIsVisible(saved !== null ? saved === 'true' : true);
    };
    
    window.addEventListener('floating-widgets-changed', handleVisibilityChange);
    return () => window.removeEventListener('floating-widgets-changed', handleVisibilityChange);
  }, []);

  // 保存字数设置
  const saveWordCount = (count: number | null) => {
    setWordCount(count);
    if (count !== null && count > 0) {
      localStorage.setItem('word_count_preset', count.toString());
    } else {
      localStorage.removeItem('word_count_preset');
    }
  };

  // 应用自定义字数
  const applyCustomCount = () => {
    const count = parseInt(customCount);
    if (count > 0) {
      saveWordCount(count);
      setCustomCount('');
      setShowCustomInput(false);
    }
  };

  // 快捷预设
  const presets = [
    { label: '100', value: 100 },
    { label: '300', value: 300 },
    { label: '500', value: 500 },
    { label: '1000', value: 1000 },
  ];

  return (
    // 如果隐藏则不渲染
    !isVisible ? null : (
    <>
      {/* 悬浮按钮 */}
      {!isPanelVisible && (
        <button
          onClick={() => setIsPanelVisible(true)}
          className="fixed bottom-24 right-24 z-50 w-12 h-12 bg-[#5B9BFF] hover:bg-[#4A8AE6] text-white rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-110"
          title="字数限制"
        >
          <Type size={20} />
          {wordCount && wordCount > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-bold">
              {wordCount}
            </span>
          )}
        </button>
      )}

      {/* 小型矩形悬浮框 */}
      {isPanelVisible && (
        <div className="fixed bottom-24 right-24 z-50 bg-simona-input border border-simona-border rounded-xl shadow-xl w-64 animate-fade-in">
          {/* 头部 */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-simona-border">
            <div className="flex items-center gap-2">
              <Type size={16} className="text-[#5B9BFF]" />
              <span className="font-semibold text-sm text-simona-text">字数限制</span>
            </div>
            <button
              onClick={() => setIsPanelVisible(false)}
              className="p-1 hover:bg-simona-hover rounded transition-colors text-simona-textSecondary hover:text-simona-text"
            >
              <X size={16} />
            </button>
          </div>

          {/* 内容 */}
          <div className="p-3 space-y-3">
            {/* 当前状态 */}
            {wordCount && wordCount > 0 ? (
              <div className="text-center py-2">
                <div className="text-2xl font-bold text-[#5B9BFF]">{wordCount}</div>
                <div className="text-xs text-simona-textSecondary mt-1">字以内</div>
              </div>
            ) : (
              <div className="text-center py-2 text-simona-textSecondary text-sm">
                未设置限制
              </div>
            )}

            {/* 快捷预设 */}
            <div className="grid grid-cols-4 gap-2">
              {presets.map(preset => (
                <button
                  key={preset.value}
                  onClick={() => saveWordCount(preset.value)}
                  className={`py-2 px-1 rounded-lg text-sm font-medium transition-all ${
                    wordCount === preset.value
                      ? 'bg-[#5B9BFF] text-white'
                      : 'bg-simona-bg text-simona-text hover:bg-simona-hover border border-simona-border'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* 自定义输入 */}
            {showCustomInput ? (
              <div className="flex gap-2">
                <input
                  type="number"
                  value={customCount}
                  onChange={(e) => setCustomCount(e.target.value)}
                  placeholder="输入字数"
                  className="flex-1 px-3 py-2 text-sm border border-simona-border rounded-lg bg-simona-bg text-simona-text focus:outline-none focus:border-[#5B9BFF]"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyCustomCount();
                  }}
                />
                <button
                  onClick={applyCustomCount}
                  disabled={!customCount || parseInt(customCount) <= 0}
                  className="px-3 py-2 bg-[#5B9BFF] hover:bg-[#4A8AE6] text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  确定
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowCustomInput(true)}
                className="w-full py-2 text-sm text-[#5B9BFF] hover:bg-[#5B9BFF]/10 rounded-lg transition-colors border border-dashed border-[#5B9BFF]/50"
              >
                + 自定义字数
              </button>
            )}

            {/* 取消限制 */}
            {wordCount && wordCount > 0 && (
              <button
                onClick={() => saveWordCount(null)}
                className="w-full py-2 text-sm text-simona-textSecondary hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              >
                取消限制
              </button>
            )}
          </div>
        </div>
      )}
    </>
    )
  );
};

export default WordCountControl;
