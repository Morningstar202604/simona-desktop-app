/**
 * Agent集群UI快速演示
 * 
 * 使用方法:
 * 1. 在MainContent.tsx中导入此文件的测试函数
 * 2. 添加一个测试按钮调用showClusterDemo()
 * 3. 点击按钮即可看到集群UI效果
 */

import { AgentState } from '../components/AgentCard';

export interface ClusterDemoState {
  isActive: boolean;
  agentCount: number;
  agents: AgentState[];
  aggregatedResult: string;
  currentPhase: 'planning' | 'executing' | 'synthesizing' | 'completed';
}

/**
 * 演示1: 两个Agent并行执行
 */
export function createParallelDemo(): ClusterDemoState {
  const now = Date.now();
  
  return {
    isActive: true,
    agentCount: 2,
    agents: [
      {
        id: 'agent-python',
        name: 'Python专家',
        modelId: 'simona-sonnet-4-6',
        status: 'running',
        startTime: now - 3000,
        content: `作为Python专家，我来分析这个问题：

Python是一种高级编程语言，具有以下特点：

1. **简洁易读** - Python的语法接近自然语言
2. **丰富的库** - numpy、pandas、tensorflow等
3. **多用途** - Web开发、数据科学、AI等
4. **动态类型** - 不需要声明变量类型

Python适合快速原型开发和数据科学项目。`,
        progress: 65,
      },
      {
        id: 'agent-js',
        name: 'JavaScript专家',
        modelId: 'simona-sonnet-4-6',
        status: 'completed',
        startTime: now - 5000,
        endTime: now - 2000,
        content: `作为JavaScript专家，我的观点是：

JavaScript是Web开发的核心语言：

1. **浏览器原生** - 唯一能在浏览器运行的语言
2. **异步编程** - Promise、async/await支持
3. **全栈能力** - Node.js让JS运行在服务器
4. **生态系统** - npm拥有最大的包管理器

JavaScript是构建交互式UI的必备技能。`,
      },
    ],
    aggregatedResult: '',
    currentPhase: 'executing',
  };
}

/**
 * 演示2: 三个Agent完成后的状态
 */
export function createCompletedDemo(): ClusterDemoState {
  const now = Date.now();
  
  return {
    isActive: false,
    agentCount: 3,
    agents: [
      {
        id: 'agent-planner',
        name: '规划师',
        modelId: 'simona-opus-4-6',
        status: 'completed',
        startTime: now - 10000,
        endTime: now - 8000,
        content: `## 问题分析

这个问题可以从以下几个角度分析：

1. 技术实现层面
2. 性能优化层面
3. 用户体验层面

建议采用分步实施的策略。`,
      },
      {
        id: 'agent-executor',
        name: '执行者',
        modelId: 'simona-sonnet-4-6',
        status: 'completed',
        startTime: now - 8000,
        endTime: now - 5000,
        content: `## 实施方案

根据规划师的建议，我制定了以下实施步骤：

### 第一阶段
- 搭建基础架构
- 配置开发环境
- 编写核心模块

### 第二阶段
- 实现业务逻辑
- 集成第三方服务
- 编写单元测试`,
      },
      {
        id: 'agent-reviewer',
        name: '审查者',
        modelId: 'simona-sonnet-4-6',
        status: 'completed',
        startTime: now - 5000,
        endTime: now - 3000,
        content: `## 代码审查意见

✅ **优点**:
- 架构设计合理
- 代码规范良好
- 测试覆盖率高

⚠️ **建议改进**:
- 增加错误处理
- 优化数据库查询
- 添加性能监控`,
      },
    ],
    aggregatedResult: `## 综合建议

经过三位专家的协作分析，我们得出以下结论：

### 技术方案
采用分步实施策略，先搭建基础架构，再逐步完善功能。

### 关键要点
1. 重视代码质量和可维护性
2. 做好性能优化和监控
3. 保持灵活的架构设计

### 下一步行动
- 立即开始第一阶段实施
- 每周进行代码审查
- 持续优化和改进`,
    currentPhase: 'completed',
  };
}

/**
 * 演示3: 包含错误Agent的状态
 */
export function createErrorDemo(): ClusterDemoState {
  const now = Date.now();
  
  return {
    isActive: false,
    agentCount: 3,
    agents: [
      {
        id: 'agent-1',
        name: '数据分析专家',
        modelId: 'simona-sonnet-4-6',
        status: 'completed',
        startTime: now - 5000,
        endTime: now - 2000,
        content: `## 数据分析结果

通过对数据的深入分析，我发现：

- 用户增长率: +15%/月
- 留存率: 68%
- 活跃度: 日均3.2次

整体趋势良好，建议继续保持当前策略。`,
      },
      {
        id: 'agent-2',
        name: '可视化专家',
        modelId: 'simona-sonnet-4-6',
        status: 'error',
        startTime: now - 5000,
        endTime: now - 4000,
        error: 'API request failed: 429 Too Many Requests',
        content: '',
      },
    ],
    aggregatedResult: `## 分析总结

由于可视化专家执行失败，我们仅基于数据分析专家的结果进行总结。

建议后续重试可视化生成，或手动创建图表。`,
    currentPhase: 'completed',
  };
}

/**
 * 演示4: 流水线策略
 */
export function createPipelineDemo(): ClusterDemoState {
  const now = Date.now();
  
  return {
    isActive: true,
    agentCount: 2,
    agents: [
      {
        id: 'agent-researcher',
        name: '研究员',
        modelId: 'simona-opus-4-6',
        status: 'completed',
        startTime: now - 10000,
        endTime: now - 7000,
        content: `已完成资料收集和研究工作。

找到相关文献15篇，核心观点如下：
- 观点A: ...
- 观点B: ...
- 观点C: ...`,
      },
      {
        id: 'agent-writer',
        name: '撰稿人',
        modelId: 'simona-sonnet-4-6',
        status: 'running',
        startTime: now - 7000,
        content: `正在根据研究员提供的资料撰写文章...

# 主题分析报告

## 引言
根据最新研究...

## 主体内容
正在编写中...`,
        progress: 45,
      },
      {
        id: 'agent-editor',
        name: '编辑',
        modelId: 'simona-sonnet-4-6',
        status: 'pending',
        content: '',
      },
    ],
    aggregatedResult: '',
    currentPhase: 'executing',
  };
}

/**
 * 在MainContent中使用示例:
 * 
 * ```tsx
 * import { createParallelDemo, ClusterDemoState } from './cluster-demo';
 * 
 * const [demoState, setDemoState] = useState<ClusterDemoState | null>(null);
 * 
 * // 添加测试按钮
 * <button onClick={() => setDemoState(createParallelDemo())}>
 *   演示集群UI
 * </button>
 * 
 * // 渲染演示面板
 * {demoState && (
 *   <AgentProgressPanel
 *     agents={demoState.agents}
 *     agentCount={demoState.agentCount}
 *     currentPhase={demoState.currentPhase}
 *     aggregatedResult={demoState.aggregatedResult}
 *     expandedAgents={expandedAgents}
 *     onToggleAgent={toggleAgentExpand}
 *   />
 * )}
 * ```
 */
