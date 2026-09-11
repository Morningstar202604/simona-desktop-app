import React from 'react';
import { Zap, TrendingUp } from 'lucide-react';
import AgentCard, { AgentState } from './AgentCard';

interface AgentProgressPanelProps {
  agents: AgentState[];
  agentCount: number;
  currentPhase: string;
  aggregatedResult?: string;
  expandedAgents?: Set<string>;
  onToggleAgent?: (agentId: string) => void;
}

const AgentProgressPanel: React.FC<AgentProgressPanelProps> = ({
  agents,
  agentCount,
  currentPhase,
  aggregatedResult,
  expandedAgents = new Set(),
  onToggleAgent,
}) => {
  const completedCount = agents.filter(a => a.status === 'completed').length;
  const totalCount = agents.length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  const getPhaseText = () => {
    switch (currentPhase) {
      case 'planning':
        return '规划者正在分析任务...';
      case 'executing':
        return `执行中 (${completedCount}/${totalCount} 完成)`;
      case 'synthesizing':
        return '整合者正在汇总结果...';
      case 'completed':
        return '蜂群执行完成';
      default:
        return '';
    }
  };

  if (agents.length === 0 && !aggregatedResult) {
    return null;
  }

  return (
    <div className="cluster-progress-panel my-4 border border-simona-border rounded-lg overflow-hidden">
      {/* 头部信息 - 白灰色系 */}
      <div className="bg-simona-bgSecondary border-b border-simona-border p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-simona-accent" />
            <span className="font-semibold text-sm text-simona-text">
              蜂群模式 ({agentCount}个Agent)
            </span>
          </div>
          <div className="text-xs text-simona-textSecondary">
            {getPhaseText()}
          </div>
        </div>
        
        {/* 进度条 */}
        {currentPhase !== 'completed' && agents.length > 0 && (
          <div className="mt-2">
            <div className="h-1.5 bg-simona-border rounded-full overflow-hidden">
              <div 
                className="h-full bg-simona-accent transition-all duration-500 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Agent卡片网格 */}
      {agents.length > 0 && (
        <div className="bg-simona-bg p-3 space-y-3">
          <div className="grid grid-cols-1 gap-3">
            {agents.map((agent, index) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                index={index}
                isExpanded={expandedAgents.has(agent.id)}
                onToggleExpand={() => onToggleAgent?.(agent.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* 聚合结果 */}
      {aggregatedResult && (
        <div className="bg-white border-t border-simona-border p-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={16} className="text-simona-textSecondary" />
            <h3 className="text-sm font-semibold text-simona-text">
              最终聚合结果
            </h3>
          </div>
          <div className="prose prose-sm max-w-none whitespace-pre-wrap">
            {aggregatedResult}
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentProgressPanel;
