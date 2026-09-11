import React from 'react';
import { X } from 'lucide-react';

interface GuideTooltipProps {
  show: boolean;
  message: string;
  subMessage?: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  onClose: () => void;
}

const GuideTooltip: React.FC<GuideTooltipProps> = ({
  show,
  message,
  subMessage,
  position = 'bottom',
  onClose,
}) => {
  if (!show) return null;

  // 根据位置计算样式
  const positionStyles = {
    top: 'bottom-full mb-2 left-1/2 -translate-x-1/2',
    bottom: 'top-full mt-2 left-0',
    left: 'right-full mr-2 top-1/2 -translate-y-1/2',
    right: 'left-full ml-2 top-1/2 -translate-y-1/2',
  };

  // 箭头位置和旋转
  const arrowStyles = {
    top: 'absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#387ee0] rotate-45',
    bottom: 'absolute -top-1 left-6 w-2 h-2 bg-[#387ee0] rotate-45',
    left: 'absolute -right-1 top-1/2 -translate-y-1/2 w-2 h-2 bg-[#387ee0] rotate-45',
    right: 'absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-2 bg-[#387ee0] rotate-45',
  };

  return (
    <div className={`absolute ${positionStyles[position]} z-50 bg-[#387ee0] text-white px-3 py-2 rounded-lg shadow-lg min-w-[200px] animate-in slide-in-from-top-2 fade-in duration-300`}>
      <div className="flex items-start gap-2">
        <span className="text-lg">💡</span>
        <div className="flex-1">
          <p className="text-[12px] font-medium mb-1">{message}</p>
          {subMessage && (
            <p className="text-[11px] opacity-90 leading-relaxed">{subMessage}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-white/70 hover:text-white transition-colors"
          title="关闭提示"
        >
          <X size={14} />
        </button>
      </div>
      {/* 小三角箭头 */}
      <div className={arrowStyles[position]} />
    </div>
  );
};

export default GuideTooltip;
