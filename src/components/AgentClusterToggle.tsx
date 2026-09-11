import React, { useState, useEffect } from 'react';
import { Zap, ChevronDown, ChevronUp } from 'lucide-react';
import GuideTooltip from './GuideTooltip';
import { useGuide } from '../hooks/useGuide';

export interface ClusterConfig {
  enabled: boolean;
  agentCount: number; // Agent数量
}

interface AgentClusterToggleProps {
  clusterEnabled: boolean;
  agentCount: number;
  onToggle: (enabled: boolean) => void;
  onAgentCountChange: (count: number) => void;
}

const AgentClusterToggle: React.FC<AgentClusterToggleProps> = ({
  clusterEnabled,
  agentCount,
  onToggle,
  onAgentCountChange,
}) => {
  const [showConfig, setShowConfig] = useState(false);
  // 每次启用蜂群模式时都显示引导
  const [showGuide, dismissGuide] = useGuide(clusterEnabled);

  // 当启用蜂群模式时，默认收起配置面板
  useEffect(() => {
    if (clusterEnabled) {
      setShowConfig(false); // 默认收起
    } else {
      setShowConfig(false);
    }
  }, [clusterEnabled]);

  return (
    <div className="relative inline-block">
      {/* 集群模式开关 */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onToggle(!clusterEnabled)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all duration-200 ${
            clusterEnabled
              ? 'bg-simona-accent text-white shadow-sm hover:shadow-md'
              : 'bg-simona-input border border-simona-border text-simona-textSecondary hover:text-simona-text hover:border-simona-textSecondary'
          }`}
          title={clusterEnabled ? '蜂群模式已启用' : '启用蜂群模式'}
        >
          <Zap size={16} />
          <span className="text-[13px] font-medium">蜂群</span>
        </button>

        {/* 展开/收起配置按钮 */}
        {clusterEnabled && (
          <button
            onClick={() => setShowConfig(!showConfig)}
            className="p-1.5 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded-lg transition-colors"
            title={showConfig ? '收起配置' : '展开配置'}
          >
            {showConfig ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>

      {/* 引导提示 - 首次使用时显示 */}
      {clusterEnabled && (
        <GuideTooltip
          show={showGuide}
          message="蜂群模式已启用"
          subMessage="点击 ▼ 图标可调节Agent数量（3-99个）"
          position="bottom"
          onClose={dismissGuide}
        />
      )}

      {/* 数量调节器 - 紧凑版 */}
      {clusterEnabled && showConfig && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-simona-input border border-simona-border rounded-lg p-2 shadow-lg min-w-[180px] animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[11px] text-simona-textSecondary whitespace-nowrap">Agent数</span>
            <input
              type="number"
              min="3"
              max="99"
              value={agentCount}
              onChange={(e) => {
                const value = parseInt(e.target.value);
                if (!isNaN(value)) {
                  const clamped = Math.max(3, Math.min(99, value));
                  onAgentCountChange(clamped);
                }
              }}
              onBlur={(e) => {
                // 失焦时确保值在范围内
                const value = parseInt(e.target.value);
                if (isNaN(value) || value < 3) {
                  onAgentCountChange(3);
                } else if (value > 99) {
                  onAgentCountChange(99);
                }
              }}
              onKeyDown={(e) => {
                // 按Enter键时失焦以触发验证
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className="w-12 h-6 px-1.5 text-[13px] font-bold text-[#387ee0] bg-[#387ee0]/10 border border-[#387ee0]/30 rounded text-center focus:outline-none focus:border-[#387ee0] transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>
          
          <input
            type="range"
            min="3"
            max="99"
            value={agentCount}
            onChange={(e) => onAgentCountChange(parseInt(e.target.value))}
            className="w-full h-1.5 bg-simona-border rounded-lg appearance-none cursor-pointer accent-[#387ee0]"
          />
          
          <div className="flex items-center justify-between text-[9px] text-simona-textSecondary mt-1 px-0.5">
            <span>3</span>
            <span>99</span>
          </div>
        </div>
      )}
    </div>
  );
};



export { AgentClusterToggle };
