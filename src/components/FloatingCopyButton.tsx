import React, { useState, useEffect, useRef, useCallback } from 'react';

interface FloatingCopyButtonProps {
  containerRef?: React.RefObject<HTMLElement | null>;
}

const FloatingCopyButton: React.FC<FloatingCopyButtonProps> = ({ containerRef }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isCopying, setIsCopying] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);

  const updateButtonPosition = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setIsVisible(false);
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // 检查选区是否在指定容器内
    if (containerRef?.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      if (
        rect.bottom < containerRect.top ||
        rect.top > containerRect.bottom ||
        rect.right < containerRect.left ||
        rect.left > containerRect.right
      ) {
        setIsVisible(false);
        return;
      }
    }

    // 计算按钮位置（选区右上角）
    const buttonWidth = 100;
    const buttonHeight = 36;
    
    let x = rect.right - buttonWidth / 2;
    let y = rect.top - buttonHeight - 8; // 选区上方 8px

    // 边界检测
    if (y < 10) {
      y = rect.bottom + 8; // 显示在选区下方
    }
    if (x < 10) x = 10;
    if (x + buttonWidth > window.innerWidth - 10) {
      x = window.innerWidth - buttonWidth - 10;
    }

    setPosition({ x, y });
    setIsVisible(true);
  }, [containerRef]);

  useEffect(() => {
    const handleSelectionChange = () => {
      updateButtonPosition();
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [updateButtonPosition]);

  const handleCopy = async () => {
    const selection = window.getSelection();
    if (!selection) return;

    const text = selection.toString();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      setIsCopying(true);
      setTimeout(() => {
        setIsCopying(false);
        setIsVisible(false);
        selection.removeAllRanges();
      }, 1000);
    } catch (err) {
      console.error('[FloatingCopyButton] Copy failed:', err);
    }
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div
      ref={buttonRef}
      className="fixed px-2.5 py-1 bg-simona-input border border-simona-border text-simona-text text-xs font-medium rounded-md shadow-lg cursor-pointer select-none hover:bg-simona-hover transition-colors duration-150 animate-fade-in"
      style={{
        left: position.x,
        top: position.y,
        zIndex: 2147483646,
      }}
      onClick={handleCopy}
      onMouseDown={(e) => e.preventDefault()}
    >
      {isCopying ? '已复制' : '复制'}
    </div>
  );
};

export default FloatingCopyButton;