import React from 'react';

interface OperationPanelProps {
  platform: 'douyin' | 'tiktok';
  onClose: () => void;
}

const features = [
  { id: 'account', name: '账号截流', icon: '👤' },
  { id: 'message', name: '私信', icon: '💬' },
  { id: 'service', name: '客服', icon: '🎧' },
  { id: 'image', name: '一键图文生成发布', icon: '🖼️' },
  { id: 'video', name: '一键视频生成发布', icon: '🎬' },
  { id: 'data', name: '账号运营数据', icon: '📊' },
];

export const OperationPanel: React.FC<OperationPanelProps> = ({ platform, onClose }) => {
  const platformName = platform === 'douyin' ? '抖音' : 'TikTok';

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-simona-border">
        <h3 className="text-[14px] font-medium text-simona-text">
          {platformName}运营功能
        </h3>
        <button
          onClick={onClose}
          className="p-1 hover:bg-simona-hover rounded transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      
      {/* 功能列表 */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-2 gap-2">
          {features.map((feature) => (
            <button
              key={feature.id}
              onClick={() => console.log(`点击功能: ${feature.name}`)}
              className="flex flex-col items-center justify-center p-4 rounded-lg bg-simona-input hover:bg-simona-hover border border-simona-border transition-all duration-200 active:scale-95"
            >
              <span className="text-2xl mb-2">{feature.icon}</span>
              <span className="text-[12px] text-simona-text text-center leading-tight">
                {feature.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default OperationPanel;
