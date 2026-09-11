import React from 'react';
import { Zap, CheckCircle, Loader, XCircle, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';

export interface AgentState {
  id: string;
  name: string;
  modelId: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  startTime?: number;
  endTime?: number;
  content: string;
  error?: string;
  progress?: number;
}

interface AgentCardProps {
  agent: AgentState;
  index: number;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

const AgentCard: React.FC<AgentCardProps> = ({ 
  agent, 
  index,
  isExpanded = true,
  onToggleExpand 
}) => {
  const getStatusIcon = () => {
    switch (agent.status) {
      case 'running':
        return <Loader size={18} className="animate-spin text-simona-accent" />;
      case 'completed':
        return <CheckCircle size={18} className="text-simona-textSecondary" />;
      case 'error':
        return <XCircle size={18} className="text-simona-textSecondary opacity-60" />;
      default:
        return <Clock size={18} className="text-simona-textSecondary opacity-40" />;
    }
  };

  const getStatusText = () => {
    switch (agent.status) {
      case 'running':
        return '运行中...';
      case 'completed':
        return '已完成';
      case 'error':
        return '失败';
      default:
        return '等待中';
    }
  };

  const getRoleColor = (role: string) => {
    // 使用白灰色系，通过边框和背景透明度区分
    const colors: Record<string, string> = {
      planner: 'bg-simona-bgSecondary border-simona-border text-simona-text',
      executor: 'bg-simona-bgSecondary border-simona-border text-simona-text',
      reviewer: 'bg-simona-bgSecondary border-simona-border text-simona-text',
      synthesizer: 'bg-simona-bgSecondary border-simona-border text-simona-text',
      general: 'bg-simona-bgSecondary border-simona-border text-simona-text',
    };
    return colors[role] || colors.general;
  };

  const getDuration = () => {
    if (!agent.startTime) return null;
    const end = agent.endTime || Date.now();
    return ((end - agent.startTime) / 1000).toFixed(1);
  };

  const duration = getDuration();

  return (
    <div 
      className={`
        agent-card rounded-lg border transition-all duration-300
        ${agent.status === 'running' ? 'border-simona-accent bg-simona-accent/10 shadow-sm' : ''}
        ${agent.status === 'completed' ? 'border-simona-border bg-white' : ''}
        ${agent.status === 'error' ? 'border-simona-border bg-simona-bgSecondary' : ''}
        ${agent.status === 'pending' ? 'border-simona-border bg-simona-bgSecondary/50' : ''}
      `}
      style={{ animation: 'agentAppear 0.3s ease-out' }}
    >
      {/* 头部 */}
      <div 
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-simona-hover rounded-t-lg"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-3">
          {/* 序号 */}
          <div className="flex items-center justify-center w-6 h-6 rounded-full bg-simona-accent/10 text-simona-accent text-xs font-bold">
            {index + 1}
          </div>
          
          {/* Agent信息 */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-simona-text">{agent.name}</h4>
            </div>
            <div className="flex items-center gap-2 text-xs text-simona-textSecondary">
              {getStatusIcon()}
              <span>{getStatusText()}</span>
              {duration && agent.status !== 'pending' && (
                <>
                  <span>•</span>
                  <span>{duration}s</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 展开/折叠按钮 */}
        {onToggleExpand && agent.content && (
          <button className="p-1 hover:bg-simona-hover rounded transition-colors text-simona-textSecondary">
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>

      {/* 进度条 (仅running状态) */}
      {agent.status === 'running' && (
        <div className="px-3 pb-2">
          <div className="h-1 bg-simona-border rounded-full overflow-hidden">
            <div 
              className="h-full bg-simona-accent transition-all duration-300"
              style={{ 
                width: `${agent.progress || 50}%`,
                animation: 'progressPulse 1.5s infinite'
              }}
            />
          </div>
        </div>
      )}

      {/* 内容区域 */}
      {isExpanded && agent.content && (
        <div className="px-3 pb-3 border-t border-simona-border pt-2">
          <div className="prose prose-sm max-w-none">
            <MarkdownRenderer content={agent.content} />
          </div>
        </div>
      )}

      {/* 错误信息 */}
      {!isExpanded && agent.status === 'error' && agent.error && (
        <div className="px-3 pb-2 text-xs text-simona-textSecondary opacity-60">
          {agent.error.substring(0, 100)}...
        </div>
      )}

      {/* 底部信息 */}
      {agent.modelId && (
        <div className="px-3 pb-2 text-[10px] text-simona-textSecondary border-t border-simona-border pt-1">
          模型: {agent.modelId}
        </div>
      )}
    </div>
  );
};

export default AgentCard;
