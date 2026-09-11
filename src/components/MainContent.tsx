import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronUp, FileText, ArrowUp, RotateCcw, Pencil, Copy, Check, Paperclip, ListCollapse, Globe, Clock, Info, Github, Plus, X, Loader2, Folder, User, Save, Zap, Trash2 } from 'lucide-react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { IconPlus, IconVoice, IconPencil, IconProjects, IconResearch, IconWebSearch } from './Icons';
import SimonaLogo from './SimonaLogo';
import { getConversation, sendMessage, createConversation, getUser, updateConversation, deleteMessagesFrom, deleteMessagesTail, deleteMessagesRound, uploadFile, deleteAttachment, compactConversation, answerUserQuestion, respondPermission, getUserUsage, getAttachmentUrl, getGenerationStatus, stopGeneration, getContextSize, getUserModels, getStreamStatus, reconnectStream, getProviderModels, getSkills, warmEngine, getProjects, createProject, Project, materializeGithub, getProviders, Provider, getProject, toggleProjectFile } from '../api';
import { addStreaming, removeStreaming, isStreaming } from '../streamingState';
import MarkdownRenderer from './MarkdownRenderer';
import ResearchPanel from './ResearchPanel';
import ModelSelector, { SelectableModel } from './ModelSelector';
import FileUploadPreview, { PendingFile } from './FileUploadPreview';
import AddFromGithubModal, { GithubAddPayload } from './AddFromGithubModal';
import FolderBrowser from './FolderBrowser';
import MessageAttachments from './MessageAttachments';
import DocumentCard, { DocumentInfo } from './DocumentCard';
import { copyToClipboard } from '../utils/clipboard';
import SearchProcess from './SearchProcess';
import DocumentCreationProcess, { DocumentDraftInfo } from './DocumentCreationProcess';
import CodeExecution from './CodeExecution';
import ToolDiffView, { shouldUseDiffView, hasExpandableContent, getToolStats } from './ToolDiffView';
import { executeCode, sendCodeResult, setStatusCallback } from '../pyodideRunner';

import { AgentState } from './AgentCard';
import { detectEmotion, EmotionType } from '../utils/emotionDetection';
import { showContextMenu, ContextMenuContainer } from './ContextMenu';
import FloatingCopyButton from './FloatingCopyButton';
import GuideTooltip from './GuideTooltip';
import SkillMarketModal from './SkillMarketModal';

function formatChatError(err: string): string {
  const lower = (err || '').toLowerCase();
  if (lower.includes('quota_exceeded') || lower.includes('额度已用完') || lower.includes('额度已用尽') || lower.includes('时段额度') || lower.includes('周期额度')) {
    return '⚠️ 当前额度已用完，请等待额度重置后再试。你可以在设置页查看额度详情。';
  }
  if (lower.includes('订阅已过期') || lower.includes('未激活') || lower.includes('inactive') || lower.includes('expired')) {
    return '⚠️ 你的订阅已过期或未激活，请续费后继续使用。';
  }
  if (lower.includes('invalid api key') || lower.includes('authentication')) {
    return '⚠️ API 认证失败，请重新登录。';
  }
  if (lower.includes('overloaded') || lower.includes('rate limit') || lower.includes('529')) {
    return '⚠️ 服务暂时繁忙，请稍后再试。';
  }
  return 'Error: ' + err;
}

// Blue skill tag shown in chat messages (hover shows tooltip)
const SkillTag: React.FC<{ slug: string; description?: string }> = ({ slug, description }) => {
  const [hover, setHover] = useState(false);
  return (
    <span className="relative inline" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span className={`text-[#4B9EFA] font-medium cursor-default transition-colors ${hover ? 'bg-[#4B9EFA]/10 rounded px-0.5 -mx-0.5' : ''}`}>
        /{slug}
      </span>
      {hover && description && (
        <div className="absolute left-0 top-full mt-2 w-[240px] p-3 bg-simona-input border border-simona-border rounded-xl shadow-lg z-[100] pointer-events-none">
          <div className="text-[12px] text-simona-textSecondary leading-snug mb-1.5">{description.length > 150 ? description.slice(0, 150) + '...' : description}</div>
          <div className="text-[11px] text-simona-textSecondary/60">Skill</div>
        </div>
      )}
    </span>
  );
};

// Overlay that mirrors textarea text: /skill-name in blue, rest in normal color
const SkillInputOverlay: React.FC<{ text: string; className?: string; style?: React.CSSProperties }> = ({ text, className, style }) => {
  const match = text.match(/^(\/[a-zA-Z0-9_-]+)([\s\S]*)$/);
  if (!match) return null;
  return (
    <div className={className} style={{ ...style, pointerEvents: 'none', position: 'absolute', top: 0, left: 0, right: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} aria-hidden>
      <span className="text-[#4B9EFA]">{match[1]}</span>
      <span className="text-simona-text">{match[2] || ''}</span>
    </div>
  );
};

const CompactingStatus = () => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // Fake progress animation
    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 95) return prev;
        // Logarithmic-like slowdown
        const remaining = 95 - prev;
        const inc = Math.max(0.2, remaining * 0.05);
        return Math.min(95, prev + inc);
      });
    }, 100);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col justify-center ml-2">
      <div className="text-[#404040] dark:text-[#d1d5db] font-serif italic text-[17px] leading-relaxed mb-1">
        Compacting our conversation so we can keep chatting...
      </div>
      <div className="flex items-center gap-3">
        <div className="w-48 h-1.5 bg-[#EAE8E1] dark:bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-[#404040] dark:bg-[#d1d5db] rounded-full transition-all duration-100 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[13px] text-[#707070] dark:text-[#9ca3af] font-medium font-mono">
          {Math.round(progress)}%
        </span>
      </div>
    </div>
  );
};

// 时间戳格式化
function formatMessageTime(dateStr: string): string {
  if (!dateStr) return '';

  let timeStr = dateStr;
  // Handle SQLite format (space instead of T)
  if (timeStr.includes(' ') && !timeStr.includes('T')) {
    timeStr = timeStr.replace(' ', 'T');
  }
  // Handle missing timezone (assume UTC if no Z or offset at end)
  if (!/Z$|[+-]\d{2}:?\d{2}$/.test(timeStr)) {
    timeStr += 'Z';
  }

  const date = new Date(timeStr);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }
  const isSameYear = date.getFullYear() === now.getFullYear();
  if (isSameYear) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function stripThinking(model: string) {
  return (model || '').replace(/-thinking$/, '');
}

function withThinking(base: string, thinking: boolean) {
  return thinking ? `${base}-thinking` : base;
}

function isThinkingModel(model: string) {
  return typeof model === 'string' && model.endsWith('-thinking');
}

// ─── Cross-mode override helpers ──────────────────────────────────────────────
// When a conversation's model belongs to a different mode than the user is
// currently in, we let the user opt to "keep using the cross-mode model".
// The choice is persisted per-conversation in localStorage so the next message
// in the same conversation continues to use the override mode without re-prompting.
function getCrossModeOverride(convId: string): 'clawparrot' | 'selfhosted' | null {
  try {
    const raw = localStorage.getItem('cross_mode_overrides');
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[convId] || null;
  } catch { return null; }
}

function setCrossModeOverride(convId: string, mode: 'clawparrot' | 'selfhosted') {
  try {
    const raw = localStorage.getItem('cross_mode_overrides');
    const map = raw ? JSON.parse(raw) : {};
    map[convId] = mode;
    localStorage.setItem('cross_mode_overrides', JSON.stringify(map));
  } catch {}
}

function clearCrossModeOverride(convId: string) {
  try {
    const raw = localStorage.getItem('cross_mode_overrides');
    if (!raw) return;
    const map = JSON.parse(raw);
    delete map[convId];
    localStorage.setItem('cross_mode_overrides', JSON.stringify(map));
  } catch {}
}

function isSearchStatusMessage(message: string) {
  if (!message) return false;
  return (
    message.startsWith('正在搜索：') ||
    message.startsWith('正在读取网页：') ||
    message.startsWith('正在浏览 GitHub：') ||
    message.startsWith('Searching:') ||
    message.startsWith('Fetching:')
  );
}

// Extract display text from content that may be a plain string or a JSON-stringified content array
function extractTextContent(content: any): string {
  if (!content) return '';
  if (typeof content !== 'string') return String(content);
  // Try to parse as JSON array (Simona API content format)
  if (content.startsWith('[')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((block: any) => block && block.type === 'text' && block.text)
          .map((block: any) => block.text)
          .join('\n');
      }
    } catch {
      // Not valid JSON, treat as plain text
    }
  }
  return content;
}

function withAuthToken(url: string) {
  if (!url || url.startsWith('data:') || /[?&]token=/.test(url)) return url;
  if (typeof window === 'undefined') return url;
  const token = localStorage.getItem('auth_token');
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function normalizeMessageDocuments(message: any): DocumentInfo[] {
  const raw = Array.isArray(message?.documents)
    ? message.documents
    : (message?.document ? [message.document] : []);
  const docs: DocumentInfo[] = [];
  const seen = new Set<string>();

  for (const doc of raw) {
    if (!doc || typeof doc !== 'object') continue;
    const key = doc.id || doc.url || doc.filename || `${doc.title || 'doc'}-${docs.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    docs.push(doc as DocumentInfo);
  }

  // Extract documents from tool calls — Write/Edit/Bash 全部支持
  if (Array.isArray(message?.toolCalls)) {
    // First pass: collect initial Write content per file path
    const fileContents = new Map<string, string>();
    const fileOrder: string[] = [];
    for (const tc of message.toolCalls) {
      if (tc.name === 'Write' && tc.input?.file_path && (tc.input?.content || tc.input?.new_string)) {
        const fp = tc.input.file_path as string;
        fileContents.set(fp, tc.input.content || tc.input.new_string);
        if (!fileOrder.includes(fp)) fileOrder.push(fp);
      }
    }
    // Second pass: apply Edit operations to the accumulated content
    for (const tc of message.toolCalls) {
      if ((tc.name === 'Edit' || tc.name === 'MultiEdit') && tc.input?.file_path && tc.input?.old_string != null && tc.input?.new_string != null) {
        const fp = tc.input.file_path as string;
        const current = fileContents.get(fp);
        if (current != null) {
          fileContents.set(fp, current.replaceAll(tc.input.old_string, tc.input.new_string));
        }
      }
    }
    // Create document entries from final content
    for (const fp of fileOrder) {
      const fileName = fp.split(/[/\\]/).pop() || fp;
      const key = `write-${fp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push({
        id: key,
        title: fileName,
        filename: fileName,
        url: '',
        content: fileContents.get(fp) || '',
        format: 'text',
      });
    }
  
    // 从 Bash tool calls 中提取通过 cat > heredoc 创建的文件
    for (const tc of message.toolCalls) {
      if (tc.name !== 'Bash') continue;
      if (typeof tc.input?.command !== 'string') continue;
      const cmd = tc.input.command;
      const catMatch = cmd.match(/cat\s+>\s+"([^"]+)"\s*<<\s*'(\w+)'\s*/);
      if (!catMatch) continue;
      const fp = catMatch[1];
      const delim = catMatch[2];
      const contentStartIdx = cmd.indexOf("'" + delim) + delim.length + 2;
      const contentNewlineAfter = cmd.indexOf('\n', contentStartIdx);
      if (contentNewlineAfter === -1) {
        // 尝试查找 \\n (转义反斜杠+n)
        const escapedNewline = cmd.indexOf('\\n', contentStartIdx);
        if (escapedNewline === -1) continue;
        const contentBodyStart = escapedNewline + 2;
        const contentEndMarker = '\\n' + delim;
        const contentEndIdx = cmd.indexOf(contentEndMarker, contentBodyStart);
        const content = contentEndIdx > 0
          ? cmd.substring(contentBodyStart, contentEndIdx)
          : cmd.substring(contentBodyStart).trimEnd();
        const fileName = fp.split(/[\\\/]/).pop() || fp;
        const key = `bash-${fp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        docs.push({
          id: key,
          title: fileName,
          filename: fileName,
          url: '',
          content: content.replace(/\\n/g, '\n').trim(),
          format: 'text',
        });
        continue;
      }
      const contentBodyStart = contentNewlineAfter + 1;
      const contentEndMarker = '\n' + delim;
      const contentEndIdx = cmd.indexOf(contentEndMarker, contentBodyStart);
      const content = contentEndIdx > 0
        ? cmd.substring(contentBodyStart, contentEndIdx)
        : cmd.substring(contentBodyStart).trimEnd();
      const fileName = fp.split(/[\\\/]/).pop() || fp;
      const key = `bash-${fp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push({
        id: key,
        title: fileName,
        filename: fileName,
        url: '',
        content: content.trim(),
        format: 'text',
      });
    }
  }

  return docs;
}

function parseInlineArtifactDisplay(content: any): { cleanedContent: string; draft: DocumentDraftInfo | null } | null {
  if (typeof content !== 'string' || !content.includes('<cp_artifact')) return null;

  const openMatch = content.match(/<cp_artifact\s+([^>]*)>/i);
  if (!openMatch || openMatch.index === undefined) return null;

  const attrsRaw = openMatch[1] || '';
  const title = (attrsRaw.match(/title="([^"]*)"/i)?.[1] || '').trim() || 'Untitled document';
  const format = (attrsRaw.match(/format="([^"]*)"/i)?.[1] || 'markdown').trim() || 'markdown';
  const openTag = openMatch[0];
  const bodyStart = openMatch.index + openTag.length;
  const closeTag = '</cp_artifact>';
  const closeIdx = content.indexOf(closeTag, bodyStart);

  if (closeIdx === -1) {
    const preview = content.slice(bodyStart).replace(/^\n/, '');
    const cleanedContent = content.slice(0, openMatch.index).trim().replace(/\n{3,}/g, '\n\n');
    return {
      cleanedContent,
      draft: {
        draftId: `inline-${title}-${format}`,
        title,
        format,
        preview,
        previewAvailable: preview.length > 0,
        done: false,
      },
    };
  }

  const preview = content.slice(bodyStart, closeIdx).replace(/^\n/, '');
  const before = content.slice(0, openMatch.index);
  const after = content.slice(closeIdx + closeTag.length);
  const cleanedContent = `${before}${after}`.trim().replace(/\n{3,}/g, '\n\n');

  return {
    cleanedContent,
    draft: {
      draftId: `inline-${title}-${format}`,
      title,
      format,
      preview,
      previewAvailable: preview.length > 0,
      done: true,
    },
  };
}

// Apply a research_* SSE event to the last assistant message in a messages array.
// Returns a new messages array (mutates a clone of the last message).
function applyResearchEvent(prev: any[], event: string, data: any): any[] {
  const newMsgs = [...prev];
  const lastIdx = newMsgs.length - 1;
  const lastMsg = newMsgs[lastIdx];
  if (!lastMsg || lastMsg.role !== 'assistant') return prev;
  const research = { ...(lastMsg.research || { sub_agents: [], sources: [], phase: null, plan: null, report: null, completed: false }) };
  research.sub_agents = [...(research.sub_agents || [])];
  research.sources = [...(research.sources || [])];
  switch (event) {
    case 'research_phase':
      research.phase = data.phase;
      research.phase_label = data.label;
      break;
    case 'research_plan':
      research.plan = { title: data.title, sub_questions: data.sub_questions };
      break;
    case 'research_subagent_started': {
      const exists = research.sub_agents.find((a: any) => a.id === data.sub_agent_id);
      if (!exists) {
        research.sub_agents.push({
          id: data.sub_agent_id,
          index: data.index,
          sub_question: data.sub_question,
          status: 'running',
          sources: [],
          findings: '',
        });
      }
      break;
    }
    case 'research_source': {
      const sub = research.sub_agents.find((a: any) => a.id === data.sub_agent_id);
      if (sub) {
        sub.sources = [...sub.sources, data.source];
      }
      // Global dedupe
      const exists = research.sources.find((s: any) => s.url === data.source.url);
      if (!exists) research.sources.push(data.source);
      break;
    }
    case 'research_finding': {
      const sub = research.sub_agents.find((a: any) => a.id === data.sub_agent_id);
      if (sub) {
        sub.findings = data.markdown || '';
      }
      break;
    }
    case 'research_subagent_done': {
      const sub = research.sub_agents.find((a: any) => a.id === data.sub_agent_id);
      if (sub) {
        sub.status = data.error ? 'error' : 'done';
        if (data.error) sub.error = data.error;
      }
      break;
    }
    case 'research_report':
      research.report = data.markdown;
      break;
    case 'research_done':
      research.completed = true;
      research.duration_ms = data.duration_ms;
      break;
    case 'research_error':
      research.error = data.error;
      research.completed = true;
      break;
  }
  newMsgs[lastIdx] = { ...lastMsg, research };
  return newMsgs;
}

function sanitizeInlineArtifactMessage(message: any) {
  if (!message || message.role !== 'assistant') return message;
  const parsed = parseInlineArtifactDisplay(message.content);
  if (!parsed) return message;

  let next = { ...message, content: parsed.cleanedContent };
  if (parsed.draft && normalizeMessageDocuments(next).length === 0) {
    next = mergeDocumentDraftIntoMessage(next, parsed.draft);
  }
  return next;
}

function mergeDocumentsIntoMessage(message: any, incomingDoc?: DocumentInfo | null, incomingDocs?: DocumentInfo[] | null) {
  const merged = [...normalizeMessageDocuments(message)];
  const queue = [
    ...(Array.isArray(incomingDocs) ? incomingDocs : []),
    ...(incomingDoc ? [incomingDoc] : []),
  ];

  for (const doc of queue) {
    if (!doc || typeof doc !== 'object') continue;
    const key = doc.id || doc.url || doc.filename || doc.title;
    if (!key) continue;
    const index = merged.findIndex(item => (item.id || item.url || item.filename || item.title) === key);
    if (index >= 0) merged[index] = doc;
    else merged.push(doc);
  }

  if (merged.length === 0) return message;
  return { ...message, document: merged[merged.length - 1], documents: merged };
}

function applyGenerationState(message: any, state: any) {
  const base = {
    ...message,
    content: state.text || message.content,
    thinking: state.thinking || message.thinking,
    thinkingSummary: state.thinkingSummary || message.thinkingSummary,
    citations: state.citations?.length ? state.citations : message.citations,
    searchLogs: state.searchLogs?.length ? state.searchLogs : message.searchLogs,
    isThinking: !state.text && !!state.thinking,
  };
  const withDocuments = mergeDocumentsIntoMessage(base, state.document, state.documents);
  const drafts = Array.isArray(state?.documentDrafts) ? state.documentDrafts : [];
  const withDrafts = drafts.length === 0
    ? withDocuments
    : drafts.reduce((acc, draft) => mergeDocumentDraftIntoMessage(acc, draft), withDocuments);
  return sanitizeInlineArtifactMessage(withDrafts);
}

function normalizeDocumentDrafts(message: any): DocumentDraftInfo[] {
  const raw = Array.isArray(message?.documentDrafts) ? message.documentDrafts : [];
  const last = raw[raw.length - 1];
  if (!last || typeof last !== 'object') return [];
  const key = last.draftId || last.draft_id || last.title || 'draft';
  return [{
    draftId: key,
    title: last.title,
    format: last.format,
    preview: last.preview,
    previewAvailable: last.previewAvailable ?? last.preview_available,
    done: !!last.done,
  }];
}

function mergeDocumentDraftIntoMessage(message: any, incomingDraft: any) {
  if (!incomingDraft || typeof incomingDraft !== 'object') return message;
  const draftId = incomingDraft.draftId || incomingDraft.draft_id || incomingDraft.title;
  if (!draftId) return message;

  const current = normalizeDocumentDrafts(message)[0] || null;
  const nextDraft: DocumentDraftInfo = {
    draftId,
    title: incomingDraft.title,
    format: incomingDraft.format,
    preview: incomingDraft.preview ?? incomingDraft.document?.content,
    previewAvailable: incomingDraft.previewAvailable ?? incomingDraft.preview_available ?? !!incomingDraft.document?.content,
    done: !!incomingDraft.done,
  };
  const merged: DocumentDraftInfo = current
    ? {
      ...current,
      ...nextDraft,
      draftId: current.draftId || nextDraft.draftId,
      title: nextDraft.title || current.title,
      format: nextDraft.format || current.format,
      preview: nextDraft.preview ?? current.preview,
      previewAvailable: nextDraft.previewAvailable ?? current.previewAvailable,
      done: typeof incomingDraft.done === 'boolean' ? incomingDraft.done : current.done,
    }
    : nextDraft;

  return { ...message, documentDrafts: [merged] };
}

interface MainContentProps {
  onNewChat: () => void; // Callback to tell sidebar to refresh
  resetKey?: number;
  tunerConfig?: any;
  onOpenDocument?: (doc: DocumentInfo) => void;
  onArtifactsUpdate?: (docs: DocumentInfo[]) => void;
  onOpenArtifacts?: () => void;
  onTitleChange?: (title: string) => void;
  onChatModeChange?: (isChat: boolean) => void;
  dialogMode?: 'agent' | 'chat'; // Dialog mode: 'agent' (智能体模式) or 'chat' (对话模式)
  setDialogMode?: (mode: 'agent' | 'chat') => void; // Callback to change dialog mode
}

// 草稿存储：在切换对话、打开设置页面时保留输入内容和附件
const draftsStore = new Map<string, { text: string; files: PendingFile[]; height: number }>();

interface ModelCatalog {
  common: SelectableModel[];
  all: SelectableModel[];
  fallback_model: string | null;
}

/** Memoized message list — skips re-render when only inputText changes */
interface MessageListProps {
  messages: any[];
  loading: boolean;
  expandedMessages: Set<number>;
  editingMessageIdx: number | null;
  editingContent: string;
  copiedMessageIdx: number | null;
  compactStatus: { state: string; message?: string };
  onSetEditingContent: (v: string) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onToggleExpand: (idx: number) => void;
  onResend: (content: string, idx: number) => void;
  onDeleteRound: (content: string, idx: number) => void;
  onEdit: (content: string, idx: number) => void;
  onCopy: (content: string, idx: number) => void;
  onOpenDocument?: (doc: DocumentInfo) => void;
  onSetMessages: React.Dispatch<React.SetStateAction<any[]>>;
  messageContentRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
  setOpenedResearchMsgId?: (id: string | null) => void;
}

const MessageList = React.memo<MessageListProps>(({
  messages, loading, expandedMessages, editingMessageIdx, editingContent,
  copiedMessageIdx, compactStatus, onSetEditingContent, onEditCancel, onEditSave,
  onToggleExpand, onResend, onDeleteRound, onEdit, onCopy, onOpenDocument, onSetMessages,
  messageContentRefs, setOpenedResearchMsgId,
}) => {
  // 情绪状态
  const [currentEmotion, setCurrentEmotion] = useState<EmotionType>('neutral');
  const [emotionIntensity, setEmotionIntensity] = useState(0.5);

  // 检测最新消息的情绪
  useEffect(() => {
    if (messages.length === 0) return;
    
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'assistant') return;
    
    // 合并思考内容和回复内容来检测情绪
    const combinedText = [
      lastMessage.thinking || '',
      lastMessage.content || '',
    ].join(' ');
    
    if (combinedText.trim()) {
      const emotion = detectEmotion(combinedText);
      setCurrentEmotion(emotion.type);
      setEmotionIntensity(emotion.intensity);
    }
  }, [messages]);

  return (
    <>
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .animate-shimmer-text {
          background: linear-gradient(90deg, var(--text-simona-secondary) 45%, var(--text-simona-main) 50%, var(--text-simona-secondary) 55%);
          background-size: 200% 100%;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: shimmer 4s linear infinite;
        }
      `}</style>
      {messages.map((msg: any, idx: number) => (
        <div key={idx} className="mb-6 group" data-message-index={idx}>
          {(msg.is_summary === 1 || msg.is_compact_boundary) && (
            <div className="flex items-center gap-3 mb-5 mt-2">
              <div className="flex-1 h-px bg-simona-border" />
              <span className="text-[12px] text-simona-textSecondary whitespace-nowrap">Context compacted above this point</span>
              <div className="flex-1 h-px bg-simona-border" />
            </div>
          )}
          {(msg.is_summary === 1 || msg.is_compact_boundary) ? null : msg.role === 'user' ? (
            editingMessageIdx === idx ? (
              <div className="flex flex-col items-end" style={{ maxWidth: '85%' }}>
                <div className="bg-[#F0EEE7] dark:bg-simona-btnHover text-simona-text px-3.5 py-2.5 text-[16px] leading-relaxed font-sans font-[350] rounded-2xl w-full">
                  <textarea
                    className="w-full bg-transparent text-simona-text outline-none resize-none text-[16px] leading-relaxed font-sans font-[350] block"
                    value={editingContent}
                    onChange={(e) => {
                      onSetEditingContent(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = e.target.scrollHeight + 'px';
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') onEditCancel();
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        onEditSave();
                      }
                    }}
                    ref={(el) => {
                      if (el) {
                        el.style.height = 'auto';
                        el.style.height = el.scrollHeight + 'px';
                        el.focus();
                      }
                    }}
                    style={{ minHeight: '40px' }}
                  />
                </div>
                <div className="flex items-center justify-between w-full mt-1.5 pr-1">
                  <div className="flex items-center gap-1 text-simona-textSecondary text-[12px]">
                    <Info size={12} />
                    <span>回车保存 · Shift+回车换行</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={onEditCancel}
                      className="text-[12px] px-2 py-1 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded transition-colors"
                    >
                      取消
                    </button>
                    <button
                      onClick={onEditSave}
                      disabled={!editingContent.trim() || editingContent === msg.content}
                      className="text-[12px] px-2 py-1 text-simona-text hover:bg-simona-hover rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      保存
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-end">
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="max-w-[85%] w-fit mb-1">
                    <MessageAttachments attachments={msg.attachments} onOpenDocument={onOpenDocument} />
                  </div>
                )}
                {(!msg.attachments || msg.attachments.length === 0) && msg.has_attachments === 1 && (
                  <div className="max-w-[85%] w-fit mb-1">
                    <div className="bg-[#F0EEE7] dark:bg-simona-btnHover text-simona-textSecondary px-3.5 py-2 text-[14px] rounded-2xl font-sans italic">
                      📎 文件已附上
                    </div>
                  </div>
                )}
                {(() => { const displayText = extractTextContent(msg.content); return displayText && displayText.trim() !== ''; })() && (
                  <div className="max-w-[85%] w-fit relative">
                    <div
                      className="bg-[#F0EEE7] dark:bg-simona-btnHover text-simona-text px-3.5 py-2.5 text-[16px] leading-relaxed font-sans font-[350] whitespace-pre-wrap break-words relative overflow-hidden"
                      style={{
                        maxHeight: expandedMessages.has(idx) ? 'none' : '300px',
                        borderRadius: ((() => {
                          const el = messageContentRefs.current.get(idx);
                          const isOverflow = el && el.scrollHeight > 300;
                          return isOverflow;
                        })()) ? '16px 16px 0 0' : '16px',
                      }}
                      ref={(el) => { if (el) messageContentRefs.current.set(idx, el); }}
                    >
                      {(() => {
                        try {
                          const text = extractTextContent(msg.content);
                          if (!text) return '';
                          const skillMatch = text.match(/^\/([a-zA-Z0-9_-]+)(\s|$)/);
                          if (skillMatch) {
                            const slug = skillMatch[1];
                            const rest = text.slice(skillMatch[0].length);
                            return <>
                              <span className="text-[#4B9EFA] font-medium">/{slug}</span>
                              {rest ? ' ' + rest : ''}
                            </>;
                          }
                          return text;
                        } catch { return extractTextContent(msg.content) || ''; }
                      })()}
                      {!expandedMessages.has(idx) && (() => {
                        const el = messageContentRefs.current.get(idx);
                        return el && el.scrollHeight > 300;
                      })() && (
                          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-[#F0EEE7] dark:from-simona-btnHover to-transparent pointer-events-none" />
                        )}
                    </div>
                    {(() => {
                      const el = messageContentRefs.current.get(idx);
                      const isOverflow = el && el.scrollHeight > 300;
                      if (!isOverflow) return null;
                      return (
                        <div className="bg-[#F0EEE7] dark:bg-simona-btnHover rounded-b-2xl px-3.5 pb-3 pt-1 -mt-[1px] relative" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                          <button onClick={() => onToggleExpand(idx)} className="text-[13px] text-simona-textSecondary hover:text-simona-text transition-colors">
                            {expandedMessages.has(idx) ? 'Show less' : 'Show more'}
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                )}
                <div className="flex items-center gap-1.5 mt-1.5 pr-1">
                  {msg.created_at && (
                    <span className="text-[12px] text-simona-textSecondary mr-1">{formatMessageTime(msg.created_at)}</span>
                  )}
                  <div className="flex items-center gap-0.5 overflow-hidden transition-all duration-200 ease-in-out max-w-0 opacity-0 group-hover:max-w-[220px] group-hover:opacity-100">
                    <button onClick={() => onDeleteRound(msg.content, idx)} className="p-1 text-simona-textSecondary hover:text-red-500 hover:bg-simona-hover rounded transition-colors" title="删除本轮对话"><Trash2 size={14} /></button>
                    <button onClick={() => onResend(msg.content, idx)} className="p-1 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded transition-colors" title="回退"><RotateCcw size={14} /></button>
                    <button onClick={() => onEdit(msg.content, idx)} className="p-1 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded transition-colors" title="编辑"><Pencil size={14} /></button>
                    <button onClick={() => onCopy(msg.content, idx)} className="p-1 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded transition-colors" title="复制">
                      {copiedMessageIdx === idx ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="px-1 text-simona-text text-[16.5px] leading-normal mt-2">
              {/* 蜂群Agent消息标识 */}
              {msg.metadata?.cluster_agent && (
                <div className="flex items-center gap-2 mb-3 pb-2 border-b border-simona-border">
                  <Zap size={16} className="text-[#387ee0]" />
                  <span className="text-[13px] font-medium text-[#387ee0]">
                    {msg.metadata.agent_name} ({msg.metadata.agent_role})
                  </span>
                  {msg.metadata.agent_model && (
                    <span className="text-[11px] text-simona-textSecondary">
                      · {msg.metadata.agent_model}
                    </span>
                  )}
                  {/* Agent正在运行时显示加载指示器 */}
                  {(!msg.content || msg.content.length === 0) && (!msg.thinking || msg.thinking.length === 0) && loading && idx === messages.length - 1 && (
                    <Loader2 size={14} className="text-[#387ee0] animate-spin ml-auto" />
                  )}
                </div>
              )}
              
              {/* 当Agent消息为空时显示占位符 */}
              {msg.metadata?.cluster_agent && (!msg.content || msg.content.length === 0) && (!msg.thinking || msg.thinking.length === 0) && loading && (
                <div className="flex items-center gap-2 text-simona-textSecondary py-2">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-[14px]">{msg.metadata.agent_name} 正在思考...</span>
                </div>
              )}
              
              {msg.thinking && (
                <div className="mb-4">
                  <div
                    className="flex items-center gap-2 cursor-pointer select-none group/think text-simona-textSecondary hover:text-simona-text transition-colors"
                    onClick={() => {
                      onSetMessages(prev =>
                        prev.map((m, i) =>
                          i === idx ? { ...m, isThinkingExpanded: !m.isThinkingExpanded } : m
                        )
                      );
                    }}
                  >
                    {msg.isThinking && (
                      <SimonaLogo autoAnimate rotate3D emotion={currentEmotion} emotionIntensity={emotionIntensity} style={{ width: '48px', height: '48px' }} />
                    )}
                    <span className={`text-[14px] ${msg.isThinking ? 'animate-shimmer-text' : 'text-simona-textSecondary'}`}>
                      {(() => {
                        if (msg.thinking_summary) return msg.thinking_summary;
                        const text = (msg.thinking || '').trim();
                        const lines = text.split('\n').filter((l: string) => l.trim());
                        const last = lines[lines.length - 1] || '';
                        const summary = last.length > 40 ? last.slice(0, 40) + '...' : last;
                        return summary || 'Thinking...';
                      })()}
                    </span>
                    <ChevronDown size={14} className={`transform transition-transform duration-200 ${msg.isThinkingExpanded ? 'rotate-180' : ''}`} />
                  </div>

                  {msg.isThinkingExpanded && (
                    <div className="mt-2 ml-1 pl-4 border-l-2 border-simona-border">
                      <div className="flex flex-col">
                        <div className="relative">
                          <div
                            className="text-simona-textSecondary leading-normal whitespace-pre-wrap overflow-hidden"
                            style={{ 
                              maxHeight: expandedMessages.has(idx) ? 'none' : '300px',
                              fontSize: '12px',
                              fontFamily: "'Comic Sans MS', 'Chalkboard SE', 'Marker Felt', cursive, sans-serif"
                            }}
                            ref={(el) => { if (el) messageContentRefs.current.set(idx, el); }}
                          >
                            {msg.thinking}
                          </div>
                          {!expandedMessages.has(idx) && (() => {
                            const el = messageContentRefs.current.get(idx);
                            return el && el.scrollHeight > 300;
                          })() && (
                              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-simona-bg to-transparent pointer-events-none" />
                            )}
                        </div>
                        {(() => {
                          const el = messageContentRefs.current.get(idx);
                          const isOverflow = el && el.scrollHeight > 300;
                          if (!isOverflow) return null;
                          return (
                            <div className="pt-1">
                              <button onClick={() => onToggleExpand(idx)} className="text-[13px] text-simona-text hover:text-simona-textSecondary transition-colors font-medium">
                                {expandedMessages.has(idx) ? 'Show less' : 'Show more'}
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                      {!msg.isThinking && (
                        <div className="flex items-center gap-2 mt-2 text-simona-textSecondary">
                          <Check size={16} />
                          <span className="text-[14px]">Done</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* Research badge */}
              {msg.research && (
                <button
                  onClick={() => setOpenedResearchMsgId(msg.id)}
                  className="mb-3 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#DBEAFE] dark:bg-[#1E3A5F] hover:bg-[#BFDBFE] dark:hover:bg-[#2A4A75] transition-colors"
                >
                  {msg.research.completed ? (
                    <IconResearch size={16} className="text-[#2E7CF6]" />
                  ) : (
                    <Loader2 size={16} className="text-[#2E7CF6] animate-spin" />
                  )}
                  <div className="text-left">
                    <div className="text-[12.5px] font-medium text-[#2E7CF6] leading-tight">
                      {msg.research.completed
                        ? `Research complete · ${(msg.research.sources || []).length} sources`
                        : msg.research.phase_label || 'Researching...'}
                    </div>
                    {msg.research.plan?.title && (
                      <div className="text-[11px] text-[#2E7CF6]/70 leading-tight mt-0.5 truncate max-w-[400px]">
                        {msg.research.plan.title}
                      </div>
                    )}
                  </div>
                </button>
              )}
              {/* Tool calls display */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (() => {
                const FRONTEND_HIDDEN = new Set(['WebSearch', 'WebFetch']);
                const visibleToolCalls = msg.toolCalls.filter((tc: any) => !FRONTEND_HIDDEN.has(tc.name));
                if (visibleToolCalls.length === 0) return null;
                const isCurrentMsg = idx === messages.length - 1;
                const isStale = (!loading && isCurrentMsg) || (idx < messages.length - 1);

                // Split text: work text (during tools) vs final text (after last tool done)
                const fullText = extractTextContent(msg.content);
                const offset = msg.toolTextEndOffset;
                const hasOffset = offset && offset > 0 && offset < fullText.length;
                const workText = hasOffset ? fullText.slice(0, offset).trim() : '';
                const finalText = hasOffset ? fullText.slice(offset).trim() : '';
                const isCurrentlyStreaming = loading && idx === messages.length - 1;
                // Tag message for MarkdownRenderer below:
                // - Streaming with tools: show nothing in main area (all text in tool section)
                // - Complete with offset: show only final text
                // - Complete without offset: show full text (fallback)
                // During streaming: compute pending text (text after last tool's textBefore)
                let consumedLen = 0;
                for (const tc of visibleToolCalls) {
                  if (tc.textBefore) consumedLen += tc.textBefore.length;
                }
                // Text currently being typed that hasn't been associated with a tool yet
                const pendingWorkText_ui = isCurrentlyStreaming ? fullText.slice(consumedLen).trim() : '';

                (msg as any)._finalText = isCurrentlyStreaming
                  ? ''  // During streaming, all text goes in tool section
                  : (hasOffset ? finalText : null);

                const toolNames = visibleToolCalls.map((tc: any) => {
                  const nameMap: Record<string, string> = {
                    'Read': 'Read file', 'Write': 'Write file', 'Edit': 'Edit file',
                    'Bash': 'Run command', 'ListDir': 'List directory',
                    'MultiEdit': 'Edit files', 'Search': 'Search',
                  };
                  return nameMap[tc.name] || tc.name;
                });
                const uniqueNames = [...new Set(toolNames)];
                const allDone = visibleToolCalls.every((tc: any) => {
                  const rs = (tc.status === 'running' && isStale) ? 'canceled' : tc.status;
                  return rs !== 'running';
                });
                const hasError = visibleToolCalls.some((tc: any) => tc.status === 'error');
                const summary = uniqueNames.join(', ');

                return (
                  <div className="mb-4">
                    <div className={`rounded-lg overflow-hidden ${!allDone ? 'bg-black/[0.04] dark:bg-white/[0.04]' : ''}`}>
                    <div
                      className="flex items-center gap-2 cursor-pointer select-none group/tool text-simona-textSecondary hover:text-simona-text transition-colors px-2 py-1.5"
                      onClick={() => {
                        onSetMessages(prev =>
                          prev.map((m, i) =>
                            i === idx ? { ...m, isToolCallsExpanded: !m.isToolCallsExpanded } : m
                          )
                        );
                      }}
                    >
                      {!allDone && (
                        <FileText size={16} className="text-simona-textSecondary animate-pulse" />
                      )}
                      {allDone && !hasError && (
                        <Check size={16} className="text-simona-textSecondary" />
                      )}
                      {allDone && hasError && (
                        <span className="text-red-400 text-[14px]">✗</span>
                      )}
                      <span className={`text-[14px] ${!allDone ? 'animate-shimmer-text' : 'text-simona-textSecondary'}`}>
                        {summary}
                      </span>
                      <ChevronDown size={14} className={`transform transition-transform duration-200 ${(msg.isToolCallsExpanded ?? (isCurrentlyStreaming || !allDone)) ? 'rotate-180' : ''}`} />
                    </div>
                    </div>

                    {(msg.isToolCallsExpanded ?? (isCurrentlyStreaming || !allDone)) && (
                      <div className="mt-2 ml-1 pl-4 border-l-2 border-simona-border space-y-2">
                        {visibleToolCalls.map((tc: any, tcIdx: number) => {
                          const inputStr = tc.input ? (typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2)) : '';
                          const rawPath = tc.input?.file_path || tc.input?.path || '';
                          const shortPath = rawPath ? rawPath.split(/[/\\]/).pop() || rawPath : '';
                          const actionLabel: Record<string, string> = {
                            'Read': 'Read', 'Write': 'Write', 'Edit': 'Edit',
                            'MultiEdit': 'Edit', 'Bash': '', 'Grep': 'Search',
                            'Glob': 'Find', 'ListDir': 'List', 'Skill': 'Skill',
                          };
                          const prefix = actionLabel[tc.name] ?? tc.name;
                          const fileOrCmd = shortPath || tc.input?.command || (inputStr.length > 80 ? inputStr.slice(0, 80) + '...' : inputStr);
                          const inputPreview = (prefix && fileOrCmd) ? `${prefix} ${fileOrCmd}` : (fileOrCmd || prefix || tc.name);
                          const realStatus = (tc.status === 'running' && isStale) ? 'canceled' : tc.status;
                          const expandable = hasExpandableContent(tc.name, tc.input, tc.result);
                          const stats = getToolStats(tc.name, tc.input);

                          return (
                            <div key={tc.id || tcIdx}>
                              {/* Interleaved text: what the model said BEFORE this tool call */}
                              {tc.textBefore && (
                                <div className="text-[13px] text-simona-textSecondary px-1 py-1.5 leading-relaxed">
                                  {tc.textBefore}
                                </div>
                              )}
                              {/* Tool card */}
                              <div className="text-[13px] bg-black/5 dark:bg-black/20 rounded-lg overflow-hidden border border-black/5 dark:border-white/5 mx-1 w-full">
                                <div
                                  className={`flex items-center justify-between px-3 py-2 transition-colors ${expandable ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5' : ''}`}
                                  onClick={() => {
                                    if (!expandable) return;
                                    onSetMessages(prev =>
                                      prev.map((m, i) => {
                                        if (i !== idx) return m;
                                        const newTc = [...m.toolCalls];
                                        newTc[tcIdx] = { ...newTc[tcIdx], isExpanded: newTc[tcIdx].isExpanded === undefined ? true : !newTc[tcIdx].isExpanded };
                                        return { ...m, toolCalls: newTc };
                                      })
                                    );
                                  }}
                                >
                                  <div className="flex items-center gap-2 overflow-hidden">
                                    {tc.name === 'Bash' ? (
                                      <span className="text-simona-textSecondary font-mono font-bold">&gt;_</span>
                                    ) : (
                                      <FileText size={14} className="text-simona-textSecondary flex-shrink-0" />
                                    )}
                                    <span className="text-simona-text font-mono text-[12px] truncate">
                                      {inputPreview || tc.name}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                                    {stats && realStatus !== 'running' && (
                                      <span className="text-[11px] font-mono flex items-center gap-1.5">
                                        {stats.added > 0 && <span className="text-green-500 dark:text-green-400">+{stats.added}</span>}
                                        {stats.removed > 0 && <span className="text-red-500 dark:text-red-400">-{stats.removed}</span>}
                                      </span>
                                    )}
                                    {realStatus === 'running' && <span className="text-simona-textSecondary text-[12px] animate-shimmer-text">Running...</span>}
                                    {realStatus === 'error' && <span className="text-red-400/80 text-[12px]">Failed</span>}
                                    {expandable && (
                                      <ChevronDown size={14} className={`text-simona-textSecondary transform transition-transform duration-200 ${(tc.isExpanded ?? false) ? 'rotate-180' : ''}`} />
                                    )}
                                  </div>
                                </div>
                                {expandable && (tc.isExpanded ?? false) && (
                                  <div className="px-2 py-2 border-t border-black/5 dark:border-white/5">
                                    {shouldUseDiffView(tc.name, tc.input) ? (
                                      <ToolDiffView toolName={tc.name} input={tc.input} result={tc.result} />
                                    ) : tc.result != null ? (
                                      <div className="px-1 text-simona-textSecondary text-[12px] font-mono max-h-[400px] overflow-y-auto whitespace-pre-wrap bg-black/5 dark:bg-black/40 rounded-md p-2">
                                        {typeof tc.result === 'string' ? (tc.result.length > 2000 ? tc.result.slice(0, 2000) + '...' : tc.result || '(Empty output)') : JSON.stringify(tc.result).slice(0, 2000)}
                                      </div>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {/* Streaming: show latest text being generated */}
                        {isCurrentlyStreaming && pendingWorkText_ui && (
                          <div className="text-[13px] text-simona-textSecondary px-1 py-1.5 leading-relaxed animate-shimmer-text">
                            {pendingWorkText_ui}
                          </div>
                        )}
                        {allDone && !isCurrentlyStreaming && (
                          <div className="flex items-center gap-2 text-simona-textSecondary pt-1 pb-1">
                            <Check size={14} />
                            <span className="text-[13px]">Done</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
              {msg.searchStatus && (!msg.searchLogs || msg.searchLogs.length === 0) && (!msg.content || msg.content.length === (msg._contentLenBeforeSearch || 0)) && loading && idx === messages.length - 1 && (
                <div className="flex items-center justify-center gap-2 text-[15px] font-medium mb-4 w-full">
                  <Globe size={18} className="text-simona-textSecondary" />
                  <span className="animate-shimmer-text">
                    Searching the web
                  </span>
                </div>
              )}

              {msg.searchLogs && msg.searchLogs.length > 0 && (
                <SearchProcess logs={msg.searchLogs} isThinking={msg.isThinking} isDone={(msg.content || '').length > (msg._contentLenBeforeSearch || 0)} />
              )}

              {normalizeDocumentDrafts(msg).length > 0 && (
                <DocumentCreationProcess drafts={normalizeDocumentDrafts(msg)} />
              )}

              <MarkdownRenderer content={(msg as any)._finalText ?? extractTextContent(msg.content)} citations={msg.citations} />
              {(() => {
                const allTextParts = [];
                const full = extractTextContent(msg.content);
                if (full) allTextParts.push(full);
                if (msg.toolCalls) {
                  for (const tc of msg.toolCalls) {
                    if (tc.result && typeof tc.result === 'string') allTextParts.push(tc.result);
                    if (tc.command && typeof tc.command === 'string') allTextParts.push(tc.command);
                    if (tc.content && typeof tc.content === 'string') allTextParts.push(tc.content);
                  }
                }
                const videoUrls = allTextParts.join(' ').match(/https?:\/\/[^\s"')>]+\.(mp4|webm|mov)(\?[^\s"')>]*)?/gi);
                if (videoUrls && videoUrls.length > 0) {
                  return [...new Set(videoUrls)].map((url, vi) => (
                    <video key={vi} src={url} controls className="max-w-full rounded-lg my-2" style={{ maxHeight: '70vh' }} preload="metadata">
                      您的浏览器不支持视频播放
                    </video>
                  ));
                }
                return null;
              })()}
              {normalizeMessageDocuments(msg).length > 0 && (
                <div className="mt-2 mb-1 space-y-2">
                  {normalizeMessageDocuments(msg).map((doc, docIdx) => (
                    <DocumentCard
                      key={doc.id || `${idx}-${docIdx}`}
                      document={doc}
                      onOpen={(openedDoc) => onOpenDocument?.(openedDoc)}
                    />
                  ))}
                </div>
              )}
              {msg.codeExecution && (
                <CodeExecution
                  code={msg.codeExecution.code}
                  status={msg.codeExecution.status}
                  stdout={msg.codeExecution.stdout}
                  stderr={msg.codeExecution.stderr}
                  images={msg.codeExecution.images}
                  error={msg.codeExecution.error}
                />
              )}
              {!msg.codeExecution && (msg as any).codeImages && (msg as any).codeImages.length > 0 && (
                <div className="my-3 space-y-2">
                  {(msg as any).codeImages.map((url: string, i: number) => (
                    <div key={i} className="rounded-lg overflow-hidden">
                      <img src={withAuthToken(url)} alt={`图表 ${i + 1}`} className="max-w-full" />
                    </div>
                  ))}
                </div>
              )}
              {/* 助手消息复制按钮 - 只在非空内容且非加载中显示 */}
              {!loading && msg.content && (
                <div className="flex items-center gap-2 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={() => onCopy(extractTextContent(msg.content), idx)} 
                    className="p-1.5 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded transition-colors" 
                    title="复制"
                  >
                    {copiedMessageIdx === idx ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
                  </button>
                </div>
              )}
              {loading && idx === messages.length - 1 && !msg.content && !msg.thinking && !msg.searchStatus && normalizeDocumentDrafts(msg).length === 0 && !(msg.toolCalls && msg.toolCalls.length > 0) && (
                <span className="inline-block ml-1 align-middle" style={{ verticalAlign: 'middle' }}>
                  <SimonaLogo breathe rotate3D emotion={currentEmotion} emotionIntensity={emotionIntensity} style={{ width: '56px', height: '56px', display: 'inline-block' }} />
                </span>
              )}
              {loading && idx === messages.length - 1 && !msg.isThinking && (msg.content || (msg.searchStatus && msg.content)) && (
                <span className="inline-block ml-1 align-middle" style={{ verticalAlign: 'middle' }}>
                  <SimonaLogo autoAnimate rotate3D emotion={currentEmotion} emotionIntensity={emotionIntensity} style={{ width: '56px', height: '56px', display: 'inline-block' }} />
                </span>
              )}
              {!loading && idx === messages.length - 1 && msg.content && (
                <div className="flex items-start gap-4 mt-6 ml-1 mb-2">
                  <SimonaLogo breathe={compactStatus.state === 'compacting'} emotion={currentEmotion} emotionIntensity={emotionIntensity} style={{ width: '52px', height: '52px', flexShrink: 0, marginTop: '2px' }} />
                  {compactStatus.state === 'compacting' && <CompactingStatus />}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
});

const MainContent = ({ onNewChat, resetKey, tunerConfig, onOpenDocument, onArtifactsUpdate, onOpenArtifacts, onTitleChange, onChatModeChange, dialogMode = 'agent', setDialogMode }: MainContentProps) => {
  const { id } = useParams(); // Get conversation ID from URL
  const location = useLocation();
  const isAndroidApp = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('app') === 'android';
  const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  const [localId, setLocalId] = useState<string | null>(null);
  const [showEntranceAnimation, setShowEntranceAnimation] = useState(false);

  // Persona state
  interface Persona {
    id: string;
    name: string;
    description: string;
    workFunction: string;
    personalPreferences: string;
  }
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [currentPersonaId, setCurrentPersonaId] = useState<string>('');
  const [showPersonaDropdown, setShowPersonaDropdown] = useState(false);
  const personaDropdownRef = useRef<HTMLDivElement>(null);

  // Use localId if we just created a chat, effectively overriding the lack of URL param until next true navigation
  const activeId = id || localId || null;

  // Sync activeId to ref for use in async callbacks
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const navigate = useNavigate();
  const [inputText, setInputText] = useState("");
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // 用 ref 存储 onArtifactsUpdate，方便在 onDone 中直接调用
  const onArtifactsUpdateRef = useRef(onArtifactsUpdate);
  onArtifactsUpdateRef.current = onArtifactsUpdate;

  // 从消息数组提取所有文档的工具函数
  const extractAllArtifacts = useCallback((msgs: any[]) => {
    const docsMap = new Map<string, DocumentInfo>();
    for (const message of msgs) {
      for (const doc of normalizeMessageDocuments(message)) {
        const key = doc.id || doc.url || doc.filename || doc.title;
        if (!key) continue;
        docsMap.set(key, doc);
      }
    }
    return Array.from(docsMap.values());
  }, []);

  // Notify parent about artifacts (被动：messages 变化后触发)
  useEffect(() => {
    if (!onArtifactsUpdateRef.current) return;
    const docs = extractAllArtifacts(messages);
    if (docs.length > 0) {
      console.log('[Artifacts] Notified:', docs.length, 'docs from', messages.length, 'msgs');
    }
    onArtifactsUpdateRef.current(docs);
  }, [messages, extractAllArtifacts]);

  // 流式完成后强制同步（在 onDone 中直接调用）
  const forceSyncArtifactsRef = useRef<any>(null);
  forceSyncArtifactsRef.current = () => {
    if (!onArtifactsUpdateRef.current) return;
    // 直接从 buffer 读取最新消息
    if (!activeIdRef.current) return;
    const buffered = messagesBufferRef.current.get(activeIdRef.current);
    if (!buffered || buffered.length === 0) return;
    const docs = extractAllArtifacts(buffered);
    console.log('[Artifacts] Force sync:', docs.length, 'docs from buffer');
    onArtifactsUpdateRef.current(docs);
  };

  // Notify parent about Chat Mode and Title
  useEffect(() => {
    const isChat = !!(activeId || messages.length > 0);
    onChatModeChange?.(isChat);
  }, [activeId, messages.length, onChatModeChange]);


  // Model state
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const isSelfHostedMode = localStorage.getItem('user_mode') === 'selfhosted';

  // Self-hosted: read chat_models from localStorage synchronously to avoid flash of wrong models
  const selfHostedModels = useMemo<SelectableModel[]>(() => {
    if (!isSelfHostedMode) return [];
    try {
      const chatModels = JSON.parse(localStorage.getItem('chat_models') || '[]');
      if (chatModels.length === 0) return [];
      const tierDescMap: Record<string, string> = {
        'opus': 'Most capable for ambitious work',
        'sonnet': 'Most efficient for everyday tasks',
        'haiku': 'Fastest for quick answers',
      };
      return chatModels.map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        enabled: 1,
        tier: m.tier || 'extra',
        description: m.tier && tierDescMap[m.tier] ? tierDescMap[m.tier] : undefined,
      }));
    } catch { return []; }
  }, [isSelfHostedMode]);

  const fallbackCommonModels = useMemo<SelectableModel[]>(() => {
    // Self-hosted: use user-configured models as fallback, not hardcoded Simona models
    if (isSelfHostedMode && selfHostedModels.length > 0) {
      const tierOrder = ['opus', 'sonnet', 'haiku'];
      const common = tierOrder.map(t => selfHostedModels.find(m => m.tier === t)).filter(Boolean) as SelectableModel[];
      return common.length > 0 ? common : selfHostedModels;
    }
    return [
      { id: 'simona-opus-4-6', name: 'Opus 4.6', enabled: 1, description: 'Most capable for ambitious work' },
      { id: 'simona-sonnet-4-6', name: 'Sonnet 4.6', enabled: 1, description: 'Most efficient for everyday tasks' },
      { id: 'simona-haiku-4-5-20251001', name: 'Haiku 4.5', enabled: 1, description: 'Fastest for quick answers' },
    ];
  }, [isSelfHostedMode, selfHostedModels]);

  const displayCommonModels = modelCatalog?.common?.length ? modelCatalog.common : fallbackCommonModels;
  const selectorModels = useMemo<SelectableModel[]>(() => {
    const visible = [...displayCommonModels];
    // Only add extra models (e.g. GPT) for self-hosted mode
    if (isSelfHostedMode) {
      const seen = new Set(visible.map(m => m.id));
      const extraModels = (modelCatalog?.all || []).filter(m => !seen.has(m.id));
      for (const model of extraModels) {
        // Tag non-tier models as 'extra' so ModelSelector can split them into "More models"
        visible.push({ ...model, tier: model.tier || 'extra' });
        seen.add(model.id);
      }
    }
    return visible;
  }, [displayCommonModels, modelCatalog, isSelfHostedMode]);

  // Initial model: for self-hosted, prefer first configured model over hardcoded simona-sonnet-4-6
  const [currentModelString, setCurrentModelString] = useState(() => {
    const saved = localStorage.getItem('default_model');
    if (saved) return saved;
    if (isSelfHostedMode && selfHostedModels.length > 0) {
      // 默认选中 DeepSeek V4 Flash（若已配置），否则用模型列表第一个
      const flash = selfHostedModels.find(m => m.id === 'deepseek-v4-flash');
      return flash ? flash.id : selfHostedModels[0].id;
    }
    return 'deepseek-v4-flash';
  });
  const [conversationTitle, setConversationTitle] = useState("");
  // Cross-mode warning: when an existing conversation's model isn't available in the
  // current user_mode (e.g. user opened a clawparrot-opus chat after switching to
  // selfhosted), we delay falling back. The first send attempt triggers a modal so
  // the user explicitly picks "keep cross-mode" or "switch to current mode model".
  const [crossModeWarning, setCrossModeWarning] = useState<{
    convId: string;
    originalModel: string;
    otherMode: 'clawparrot' | 'selfhosted';
    fallbackModel: string;
  } | null>(null);
  // After user picks "switch model", we proceed to send. Stash the pending send args
  // here so the modal callback can fire them after dismissal.
  const pendingCrossModeSendRef = useRef<(() => void) | null>(null);
  // Clawparrot login-required gate: shown when an un-logged-in clawparrot user
  // tries to send their first message.
  const [showLoginRequired, setShowLoginRequired] = useState(false);
  const pendingLoginSendRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onTitleChange?.(conversationTitle);
  }, [conversationTitle, onTitleChange]);

  const [user, setUser] = useState<any>(null);

  // Welcome greeting — randomized per new chat, time-aware
  const welcomeGreeting = useMemo(() => {
    const hour = new Date().getHours();
    const name = user?.display_name || user?.nickname || '朋友';
    const timeGreetings = hour < 6
      ? [`夜猫子模式，${name}`, `还在熬夜吗，${name}？`, `这么晚还没睡，${name}？`]
      : hour < 12
        ? [`早上好，${name}`, `早安，${name}`, `新的一天开始了，${name}`]
        : hour < 18
          ? [`下午好，${name}`, `你好，${name}`, `有什么想聊的吗，${name}？`]
          : [`晚上好，${name}`, `傍晚好，${name}`, `准备休息了吗，${name}？`];
    const general = [`我能帮您什么？`, `今天有什么可以帮您的？`, `开始工作吧，${name}`, `准备好了，${name}`];
    const pool = [...timeGreetings, ...general];
    return pool[Math.floor(Math.random() * pool.length)];
  }, [resetKey, user?.nickname]);

  // 运营平台选择状态（单选）
  const [selectedPlatform, setSelectedPlatform] = useState<'douyin' | 'tiktok' | null>(null);
  // 微信连接状态
  const [wechatConnected, setWechatConnected] = useState(false);
  const [wechatConnecting, setWechatConnecting] = useState(false);
  const [wechatMessage, setWechatMessage] = useState('');
  // 微信按钮点击动画状态
  const [wechatAnimating, setWechatAnimating] = useState(false);
  // 微信二维码弹窗
  const [wechatQrVisible, setWechatQrVisible] = useState(false);
  const [wechatQrUrl, setWechatQrUrl] = useState('');
  const [wechatQrLoading, setWechatQrLoading] = useState(false);
  const wechatQrTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 轮询微信连接状态（每10秒检查一次）
  useEffect(() => {
    const checkWechatStatus = async () => {
      try {
        const res = await fetch('http://127.0.0.1:30080/api/wechat/status');
        const data = await res.json();
        setWechatConnected(data.connected || false);
        if (data.connected) {
          setWechatMessage('微信已连接');
        }
      } catch (e) {
        // 网关未运行，视为未连接
        setWechatConnected(false);
      }
    };
    checkWechatStatus(); // 初始检查
    const interval = setInterval(checkWechatStatus, 10000); // 每10秒检查
    return () => clearInterval(interval);
  }, []);

  // 获取微信登录二维码
  const fetchWechatQrCode = async (): Promise<string | null> => {
    try {
      const res = await fetch('http://127.0.0.1:30080/api/wechat/qr');
      const data = await res.json();
      if (data.success && data.qrCodeUrl) {
        return data.qrCodeUrl;
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  // 轮询二维码状态
  const startQrPolling = () => {
    setWechatQrLoading(true);
    let attempts = 0;
    const maxAttempts = 60; // 最多轮询 60 次（约 3 分钟）

    const poll = async () => {
      attempts++;
      if (attempts > maxAttempts) {
        setWechatQrLoading(false);
        setWechatQrVisible(false);
        setWechatMessage('二维码已过期，请重新点击连接微信');
        return;
      }

      try {
        const res = await fetch('http://127.0.0.1:30080/api/wechat/status');
        const data = await res.json();

        if (data.connected) {
          // 已连接
          setWechatConnected(true);
          setWechatQrVisible(false);
          setWechatQrLoading(false);
          setWechatMessage('微信已连接');
          if (wechatQrTimerRef.current) {
            clearInterval(wechatQrTimerRef.current);
            wechatQrTimerRef.current = null;
          }
        } else if (!data.portOccupied) {
          // 网关已停止
          setWechatQrLoading(false);
          setWechatQrVisible(false);
          setWechatMessage('网关已停止，请重新连接');
          if (wechatQrTimerRef.current) {
            clearInterval(wechatQrTimerRef.current);
            wechatQrTimerRef.current = null;
          }
        }
        // 继续轮询
      } catch (e) {
        // 忽略错误，继续轮询
      }
    };

    poll(); // 立即执行第一次
    wechatQrTimerRef.current = setInterval(poll, 3000); // 每 3 秒轮询一次
  };

  // 停止二维码轮询
  const stopQrPolling = () => {
    if (wechatQrTimerRef.current) {
      clearInterval(wechatQrTimerRef.current);
      wechatQrTimerRef.current = null;
    }
  };

  // 清理轮询（组件卸载时）
  useEffect(() => {
    return () => {
      stopQrPolling();
    };
  }, []);

  // 微信连接/断开处理
  const handleWechatConnect = async () => {
    setWechatConnecting(true);
    setWechatMessage('正在启动网关...');
    try {
      const res = await fetch('http://127.0.0.1:30080/api/wechat/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.success) {
        // 显示二维码弹窗
        setWechatQrLoading(true);
        setWechatQrVisible(true);

        // 首次获取二维码
        const qrUrl = await fetchWechatQrCode();
        if (qrUrl) {
          setWechatQrUrl(qrUrl);
        }

        // 开始轮询连接状态
        startQrPolling();
        setWechatMessage('请扫码登录微信');
      } else {
        // 启动失败，检查原因
        const statusRes = await fetch('http://127.0.0.1:30080/api/wechat/status');
        const statusData = await statusRes.json();

        if (statusData.portOccupied) {
          // 端口被占用，网关已连接
          setWechatConnected(true);
          setWechatMessage('已连接 OpenClaw');
          setWechatQrVisible(false);
          setWechatQrLoading(false);
        } else {
          // 网关启动失败
          setWechatMessage('请先安装 OpenClaw');
          setWechatQrVisible(false);
          setWechatQrLoading(false);
          // 提示用户安装
          setTimeout(() => {
            setWechatMessage('OpenClaw 网关功能已移除');
          }, 2000);
        }
      }
    } catch (e) {
      setWechatMessage('连接失败：' + e.message);
    } finally {
      setWechatConnecting(false);
    }
  };

  const handleWechatDisconnect = async () => {
    stopQrPolling();
    setWechatQrVisible(false);
    setWechatQrUrl('');
    setWechatConnecting(true);
    setWechatMessage('正在断开...');
    try {
      const res = await fetch('http://127.0.0.1:30080/api/wechat/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.success) {
        setWechatConnected(false);
        setWechatMessage('已断开连接');
      } else {
        setWechatMessage(data.error || '断开失败');
      }
    } catch (e) {
      setWechatMessage('断开失败：' + e.message);
    } finally {
      setWechatConnecting(false);
    }
  };

  // 输入栏参数
  const inputBarWidth = 768;
  const inputBarMinHeight = 32;
  const inputBarRadius = 22;
  const inputBarBottom = 0;
  const inputBarBaseHeight = inputBarMinHeight + 16; // border-box: content + padding (pt-4=16px + pb-0=0px)
  const textareaHeightVal = useRef(inputBarBaseHeight);

  // 手机端长按回车键换行输入：记录按下时间，区分短按(发送)与长按(换行)
  const enterPressStartRef = useRef(0);
  const enterPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterLongPressFiredRef = useRef(false);
  const imeNewlineRef = useRef(false);

  const isCreatingRef = useRef(false);
  const pendingInitialMessageRef = useRef<string | null>(null);
  // Per-conversation stream state — 每个会话独立持有流 ID 与 AbortController。
  // 旧实现的 streamConversationIdRef/streamRequestIdRef/abortControllerRef 是全局单例，
  // 当会话 A 在后台长任务时，会话 B 一旦发送，beginStreamSession(B) 就会覆盖全局流标记，
  // 导致 A 的所有 SSE 回调 isStreamSessionActive(A) 判为 false → A 的回复"被停止"。
  // 改为按会话隔离后，A 的流与 B 的流互不干扰，多会话可真正并发。
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const clusterAbortControllerRef = useRef<AbortController | null>(null);
  const clusterStreamingRef = useRef(false); // Track if cluster mode is actively streaming
  const activeRequestCountRef = useRef(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResetKeyRef = useRef(0);
  const streamSessionsRef = useRef(new Map<string, number>());
  const activeIdRef = useRef<string | null>(null);

  // Per-conversation message buffer for multi-conversation streaming isolation
  const viewingIdRef = useRef<string | null>(null);
  const messagesBufferRef = useRef(new Map<string, any[]>());

  // Update messages for a specific conversation — only touches React state if it's the active conversation.
  //
  // Backfill safety net: setMessagesFor is called exclusively from streaming SSE event
  // handlers (text deltas, thinking deltas, tool events, done/error callbacks). They all
  // mutate the trailing assistant placeholder. If a race causes the updater to run BEFORE
  // the placeholder push has committed (rare but real — depends on React batching, async
  // boundaries, and SSE chunk timing), the original updaters silently dropped the event
  // via their `lastMsg.role === 'assistant'` guard.
  //
  // The fix: ensure the tail of `prev` is an assistant message before invoking the
  // updater. Existing callers don't change — their guard now always passes, and the
  // event lands on the backfilled placeholder. The bridge will overwrite this placeholder
  // with the canonical message + toolCalls when finishTurn flushes to db, so even if a
  // re-load races with backfill the persistent state stays correct.
  const setMessagesFor = useCallback((convId: string, updater: (prev: any[]) => any[]) => {
    const ensureUpdater = (prev: any[]) => {
      if (prev.length === 0) return updater(prev); // empty conv: don't synthesize a phantom placeholder
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant') return updater(prev);
      // Tail is a user message (or other non-assistant). Backfill an assistant
      // placeholder so the trailing SSE event has somewhere to land instead of
      // being silently dropped by the updater's `lastMsg.role === 'assistant'` guard.
      return updater([...prev, { role: 'assistant', content: '' }]);
    };

    if (viewingIdRef.current === convId) {
      setMessages(prev => {
        const result = ensureUpdater(prev);
        messagesBufferRef.current.set(convId, result);
        return result;
      });
    } else {
      // 后台会话增量更新 buffer（供切回显示）。若 buffer 已被 onDone/onError 清理
      // （get 返回 undefined），不要用空数组重建 —— 否则会把该会话的整段历史
      // 覆盖为仅剩一条 assistant 消息，切回时丢数据。
      const prev = messagesBufferRef.current.get(convId);
      if (prev === undefined) return;
      messagesBufferRef.current.set(convId, ensureUpdater(prev));
    }
  }, []);

  const isModelSelectable = useCallback((modelString: string) => {
    const base = stripThinking(modelString);
    const pool = modelCatalog?.all || displayCommonModels;
    const found = pool.find(m => m.id === base);
    return !!found && Number(found.enabled) === 1;
  }, [modelCatalog, displayCommonModels]);

  const resolveModelForNewChat = useCallback((preferredModel?: string | null) => {
    const saved = preferredModel || localStorage.getItem('default_model') || 'simona-sonnet-4-6';
    const thinking = true; // 默认开启思考
    const base = stripThinking(saved);
    const all = modelCatalog?.all || displayCommonModels;
    const preferred = all.find(m => m.id === base);
    if (preferred && Number(preferred.enabled) === 1) {
      return withThinking(base, thinking);
    }

    const fallbackBase = modelCatalog?.fallback_model
      || all.find(m => /sonnet/i.test(m.id) && Number(m.enabled) === 1)?.id
      || all.find(m => Number(m.enabled) === 1)?.id
      || base
      || 'simona-sonnet-4-6';
    return withThinking(fallbackBase, thinking);
  }, [displayCommonModels, modelCatalog]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const userScrolledUpRef = useRef(false);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(new Set());
  const [copiedMessageIdx, setCopiedMessageIdx] = useState<number | null>(null);
  const [editingMessageIdx, setEditingMessageIdx] = useState<number | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const messageContentRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [inputHeight, setInputHeight] = useState(160);
  const [inputCollapsed, setInputCollapsed] = useState(false);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null); // For project file uploads
  const [isDragging, setIsDragging] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [researchMode, setResearchMode] = useState(false);
  const [openedResearchMsgId, setOpenedResearchMsgId] = useState<string | null>(null);
  const toggleResearchMode = useCallback(async () => {
    const next = !researchMode;
    setResearchMode(next);
    if (activeId) {
      try { await updateConversation(activeId, { research_mode: next }); } catch (_) {}
    }
  }, [researchMode, activeId]);

  // Agent集群模式状态
  const [clusterEnabled, setClusterEnabled] = useState(false);
  const [clusterConfig, setClusterConfig] = useState(() => {
    const saved = localStorage.getItem('cluster_config');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // 确保有 agentCount，默认值为 3
        if (parsed.agentCount === undefined) {
          parsed.agentCount = 3;
        }
        return parsed;
      } catch (e) {
        console.error('[Cluster] Failed to parse config:', e);
      }
    }
    return {
      enabled: false,
      agents: [],
      strategy: 'parallel' as const,
      agentCount: 3, // 默认值
    };
  });

  // 引导提示状态 - 每次切换都显示
  const [showAgentModeGuide, setShowAgentModeGuide] = useState(false);

  // 监听dialogMode变化，显示引导
  useEffect(() => {
    if (dialogMode) {
      setShowAgentModeGuide(true);
      const timer = setTimeout(() => {
        setShowAgentModeGuide(false);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [dialogMode]);

  // 集群执行状态
  interface ClusterExecutionState {
    isActive: boolean;
    agentCount: number; // Agent数量
    agents: AgentState[];
    aggregatedResult: string;
    currentPhase: 'planning' | 'executing' | 'synthesizing' | 'completed';
  }
  const [clusterState, setClusterState] = useState<ClusterExecutionState | null>(null);
  
  // 滚动指示器状态
  const [visibleDots, setVisibleDots] = useState(false);
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const [hoveredDot, setHoveredDot] = useState<number | null>(null);

  // 滚动到指定消息
  const scrollToMessage = (index: number) => {
    const messageElements = document.querySelectorAll('[data-message-index]');
    if (messageElements[index]) {
      (messageElements[index] as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // 获取用户消息的索引（用于显示小圆点）
  const getUserMessageIndices = () => {
    return messages
      .map((msg, idx) => msg.role === 'user' ? idx : -1)
      .filter(idx => idx !== -1);
  };

  // 保存集群配置到localStorage
  useEffect(() => {
    localStorage.setItem('cluster_enabled', String(clusterEnabled));
  }, [clusterEnabled]);

  useEffect(() => {
    localStorage.setItem('cluster_config', JSON.stringify(clusterConfig));
  }, [clusterConfig]);

  // Load personas from localStorage
  useEffect(() => {
    try {
      const savedPersonas = localStorage.getItem('personas');
      if (savedPersonas) {
        const parsed = JSON.parse(savedPersonas);
        setPersonas(parsed);
        
        // Clean up polluted original profiles (if they contain 林墨's data)
        try {
          const origProfile = JSON.parse(localStorage.getItem('original_user_profile') || '{}');
          if (origProfile.work_function?.includes('林墨') || origProfile.work_function?.includes('后端架构师')) {
            localStorage.removeItem('original_user_profile');
            localStorage.removeItem('original_user');
            console.log('[Persona] Cleaned polluted original profile');
          }
        } catch {}
        
        const currentId = localStorage.getItem('current_persona_id');
        if (currentId && parsed.find((p: Persona) => p.id === currentId)) {
          setCurrentPersonaId(currentId);
          
          // Apply current persona's profile - direct assignment, NO fallback
          const persona = parsed.find((p: Persona) => p.id === currentId);
          if (persona) {
            const updatedProfile = {
              ...JSON.parse(localStorage.getItem('user_profile') || '{}'),
              work_function: persona.workFunction,
              personal_preferences: persona.personalPreferences,
            };
            localStorage.setItem('user_profile', JSON.stringify(updatedProfile));
            
            const existingUser = JSON.parse(localStorage.getItem('user') || '{}');
            if (Object.keys(existingUser).length > 0) {
              const updatedUser = {
                ...existingUser,
                work_function: persona.workFunction,
                personal_preferences: persona.personalPreferences,
              };
              localStorage.setItem('user', JSON.stringify(updatedUser));
            }
            console.log('[Persona] Applied current persona:', persona.name);
          }
        }
      }
    } catch (e) {
      console.error('Failed to load personas:', e);
    }
  }, []);

  // Provider web-search capability (derived from the current model's provider).
  // The bridge strips web_search_20250305 automatically when the provider doesn't support it,
  // so this state is purely a UI indicator — no need to persist or toggle.
  const [providersCache, setProvidersCache] = useState<Provider[]>([]);
  const [webSearchToast, setWebSearchToast] = useState<string | null>(null);
  useEffect(() => {
    getProviders().then(setProvidersCache).catch(() => {});
  }, []);
  const currentProviderSupportsWebSearch = useMemo(() => {
    if (!providersCache.length) return false;
    const bareModel = (currentModelString || '').replace(/-thinking$/, '');
    for (const p of providersCache) {
      if ((p.models || []).some(m => m.id === bareModel)) {
        return p.supportsWebSearch === true;
      }
    }
    return false;
  }, [providersCache, currentModelString]);
  useEffect(() => {
    if (!webSearchToast) return;
    const t = setTimeout(() => setWebSearchToast(null), 2800);
    return () => clearTimeout(t);
  }, [webSearchToast]);
  const [showSkillsSubmenu, setShowSkillsSubmenu] = useState(false);
  const [enabledSkills, setEnabledSkills] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  const [selectedSkill, setSelectedSkill] = useState<{ name: string; slug: string; description?: string } | null>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  // Add-to-project state
  const [showProjectsSubmenu, setShowProjectsSubmenu] = useState(false);
  const [projectList, setProjectList] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [projectAddToast, setProjectAddToast] = useState<string | null>(null);
  const [compactStatus, setCompactStatus] = useState<{ state: 'idle' | 'compacting' | 'done' | 'error'; message?: string }>({ state: 'idle' });
  const [showCompactDialog, setShowCompactDialog] = useState(false);
  const [compactInstruction, setCompactInstruction] = useState('');
  const [autoCompactTriggered, setAutoCompactTriggered] = useState(false);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [skillMarketCategory, setSkillMarketCategory] = useState<string | null>(null);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null); // null = loading
  const [contextInfo, setContextInfo] = useState<{ tokens: number; limit: number } | null>(null);
  
  // Project file selector state
  const [currentProjectFiles, setCurrentProjectFiles] = useState<any[]>([]);
  const [showTokenBar, setShowTokenBar] = useState(() => {
    const saved = localStorage.getItem('show_token_bar');
    if (saved !== null) return saved === 'true';
    return typeof window !== 'undefined' && window.innerWidth >= 768;
  });
  const [showSwarmButton] = useState(false);
  const [availableProjects, setAvailableProjects] = useState<any[]>([]);
  const [selectedProjectForFiles, setSelectedProjectForFiles] = useState<string | null>(null);
  
  // 监听悬浮组件设置变化
  useEffect(() => {
    const handleWidgetsChange = () => {
      const savedTokenBar = localStorage.getItem('show_token_bar');
      setShowTokenBar(savedTokenBar !== null ? savedTokenBar === 'true' : window.innerWidth >= 768);
      // 蜂群按钮已隐藏
    };
    window.addEventListener('floating-widgets-changed', handleWidgetsChange);
    return () => window.removeEventListener('floating-widgets-changed', handleWidgetsChange);
  }, []);

  // Load project files when currentProjectId changes
  useEffect(() => {
    console.log('[Project Files] currentProjectId changed:', currentProjectId);
    // This useEffect is no longer needed as we load files directly in loadConversation
    // Keeping it for handling project changes from other sources
    if (currentProjectId) {
      getProject(currentProjectId).then((data: any) => {
        setCurrentProjectFiles(data.files || []);
      }).catch(() => {});
    }
  }, [currentProjectId]);
  
  // Load available projects on mount for file selector
  useEffect(() => {
    console.log('[Init] Loading available projects');
    getProjects().then((projects: any[]) => {
      console.log('[Init] Loaded projects:', projects?.length || 0);
      setAvailableProjects(projects || []);
      // If no current project files, try to load from first available project
      if (currentProjectFiles.length === 0) {
        const projectWithFiles = projects?.find((p: any) => p.files && p.files.length > 0);
        if (projectWithFiles) {
          console.log('[Init] Found project with files:', projectWithFiles.name, 'files:', projectWithFiles.files?.length);
          setSelectedProjectForFiles(projectWithFiles.id);
          setCurrentProjectFiles(projectWithFiles.files || []);
        }
      }
    }).catch((err) => {
      console.error('[Init] Failed to load projects:', err);
    });
  }, []);
  
  const handleToggleProjectFile = async (fileId: string) => {
    const projectId = currentProjectId || selectedProjectForFiles;
    if (!projectId) return;
    const file = currentProjectFiles.find(f => f.id === fileId);
    if (!file) return;
    await toggleProjectFile(projectId, fileId, !file.enabled);
    // Refresh files
    getProject(projectId).then((data: any) => {
      setCurrentProjectFiles(data.files || []);
    }).catch(() => {});
  };

  // AskUserQuestion state
  const [askUserDialog, setAskUserDialog] = useState<{
    request_id: string;
    tool_use_id: string;
    questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
    answers: Record<string, string>;
  } | null>(null);

  // Tool permission approval dialog state
  const [permissionDialog, setPermissionDialog] = useState<{
    request_id: string;
    tool_use_id: string;
    tool_name: string;
    tool_input: any;
  } | null>(null);

  // Task/Agent progress state
  const [activeTasks, setActiveTasks] = useState<Map<string, { description: string; status?: string; summary?: string; last_tool_name?: string }>>(new Map());
  // 任务卡折叠状态（展开/收起，避免多任务堆叠）
  const [tasksCollapsed, setTasksCollapsed] = useState(false);

  // Plan mode state
  const [planMode, setPlanMode] = useState(false);

  // 草稿持久化 refs（跟踪最新值，供 effect cleanup 读取）
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;
  const pendingFilesRef = useRef(pendingFiles);
  pendingFilesRef.current = pendingFiles;
  const textareaHeightRef = useRef(textareaHeightVal.current);
  textareaHeightRef.current = textareaHeightVal.current;

  // textarea 高度计算改为在 onChange 中直接操作 DOM（见 adjustTextareaHeight）
  const adjustTextareaHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = `${inputBarBaseHeight}px`;
    const sh = el.scrollHeight;
    const newH = sh > inputBarBaseHeight ? Math.min(sh, 316) : inputBarBaseHeight;
    el.style.height = `${newH}px`;
    el.style.overflowY = newH >= 316 ? 'auto' : 'hidden';
    textareaHeightVal.current = newH;
  }, [inputBarBaseHeight]);

  useEffect(() => {
    // If we have a URL param ID, clear any local ID to ensure we sync with source of truth
    if (id) {
      setLocalId(null);
    }
  }, [id]);

  // 检测滚动条宽度
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = () => setScrollbarWidth(el.offsetWidth - el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [messages]);

  // 动态调整 paddingBottom，使聊天列表能滚到输入框上方
  useEffect(() => {
    const el = inputWrapperRef.current;
    if (!el) return;

    const updateHeight = () => {
      // 底部留白 = 输入框高度 + 底部边距(48px)
      setInputHeight(el.offsetHeight + 48);
    };

    // 初始测量
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);

    return () => observer.disconnect();
  }, [activeId, messages.length]);

  // 用户滚轮向上时，立刻中止自动滚动
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        userScrolledUpRef.current = true;
        isAtBottomRef.current = false;
        // 取消正在进行的 smooth scroll 动画
        el.scrollTo({ top: el.scrollTop });
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: true });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // Load enabled skills for the plus menu
  useEffect(() => {
    if (!showPlusMenu) { setShowSkillsSubmenu(false); setShowProjectsSubmenu(false); return; }
    getSkills().then((data: any) => {
      const all = [...(data.examples || []), ...(data.my_skills || [])];
      setEnabledSkills(all.filter((s: any) => s.enabled).map((s: any) => ({ id: s.id, name: s.name, description: s.description })));
    }).catch(() => {});
    getProjects().then((data: Project[]) => {
      setProjectList((data || []).filter(p => !p.is_archived));
    }).catch(() => {});
  }, [showPlusMenu]);

  // 点击外部关闭加号菜单
  useEffect(() => {
    if (!showPlusMenu) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideMenu = plusMenuRef.current && plusMenuRef.current.contains(target);
      const insideButton = plusBtnRef.current && plusBtnRef.current.contains(target);
      if (!insideMenu && !insideButton) {
        setShowPlusMenu(false);
        setShowSkillsSubmenu(false);
        setShowProjectsSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPlusMenu]);

  // 点击外部关闭人设下拉菜单
  useEffect(() => {
    if (!showPersonaDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (personaDropdownRef.current && !personaDropdownRef.current.contains(e.target as Node)) {
        setShowPersonaDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPersonaDropdown]);

  // Reset when resetKey changes (New Chat clicked)
  useEffect(() => {
    if (resetKey && resetKey !== lastResetKeyRef.current) {
      lastResetKeyRef.current = resetKey;
      setLocalId(null);
      setMessages([]);
      setCurrentModelString(resolveModelForNewChat());
      setConversationTitle("");
      setContextInfo(null);
      setCurrentProjectId(null);
      setPendingProjectId(null);
      // 触发入场动画
      setShowEntranceAnimation(true);
      setTimeout(() => setShowEntranceAnimation(false), 800);
      isAtBottomRef.current = true;

      // Check for prefill input (from Create with Simona)
      const prefillInput = sessionStorage.getItem('prefill_input');
      if (prefillInput) {
        sessionStorage.removeItem('prefill_input');
        setTimeout(() => {
          setInputText(prefillInput);
          // Auto-resize textarea
          const ta = document.querySelector('textarea');
          if (ta) {
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 316) + 'px';
          }
        }, 200);
      }

      // Check for artifact prompt (from Artifacts page)
      const artifactPrompt = sessionStorage.getItem('artifact_prompt');
      if (artifactPrompt) {
        sessionStorage.removeItem('artifact_prompt');
        if (artifactPrompt === '__remix__') {
          // Remix mode: pre-load artifact into conversation
          const remixData = sessionStorage.getItem('artifact_remix');
          sessionStorage.removeItem('artifact_remix');
          if (remixData) {
            try {
              const remix = JSON.parse(remixData);
              // Inject pre-baked assistant message with artifact info
              const assistantMsg = {
                id: 'remix-' + Date.now(),
                role: 'assistant' as const,
                content: JSON.stringify([{ type: 'text', text: `I'll customize this artifact:\n\n**${remix.name}**\n\nTransform any artifact into something uniquely yours by customizing its core elements.\n\n1. Change the topic - Adapt the content for a different subject\n2. Update the style - Refresh the visuals or overall design\n3. Make it personal - Tailor specifically for your needs\n4. Share your vision - I'll bring it to life\n\nWhere would you like to begin?` }]),
                created_at: new Date().toISOString(),
              };
              setTimeout(() => {
                setMessages([assistantMsg]);
                // Open the artifact in DocumentPanel
                if (remix.code?.content && onOpenDocument) {
                  const isReactArtifact = remix.code?.type === 'application/vnd.ant.react';
                  onOpenDocument({
                    id: 'remix-artifact',
                    title: remix.code?.title || remix.name,
                    filename: (remix.code?.title || remix.name) + (isReactArtifact ? '.jsx' : '.html'),
                    url: '',
                    content: remix.code.content,
                    format: isReactArtifact ? 'jsx' : 'html',
                  });
                }
              }, 200);
            } catch {}
          }
        } else {
          // Normal artifact prompt: auto-send
          setTimeout(() => handleSend(artifactPrompt), 300);
        }
      }
    }
  }, [resetKey, resolveModelForNewChat]);

  useEffect(() => {
    let cancelled = false;
    const loadModels = async () => {
      try {
        // Sync model settings from bridge-server (web control panel)
        const { syncSettingsFromServer } = await import('../utils/modelSettingsSync');
        await syncSettingsFromServer();
        const isSelfHosted = localStorage.getItem('user_mode') === 'selfhosted';
        let data: any;
        if (isSelfHosted) {
          // Self-hosted: use chat_models from localStorage (configured in Models settings)
          let chatModels: any[] = [];
          try { chatModels = JSON.parse(localStorage.getItem('chat_models') || '[]'); } catch {}
          if (chatModels.length > 0) {
            const tierDescMap: Record<string, string> = {
              'opus': 'Most capable for ambitious work',
              'sonnet': 'Most efficient for everyday tasks',
              'haiku': 'Fastest for quick answers',
            };
            const all = chatModels.map((m: any) => ({
              id: m.id,
              name: m.name || m.id,
              enabled: 1,
              tier: m.tier || 'extra',
              description: m.tier && tierDescMap[m.tier] ? tierDescMap[m.tier] : undefined,
            }));
            // Common = tier models (opus/sonnet/haiku), ordered by tier
            const tierOrder = ['opus', 'sonnet', 'haiku'];
            const common = tierOrder.map(t => all.find((m: any) => m.tier === t)).filter(Boolean);
            data = { all, common: common.length > 0 ? common : all, fallback_model: localStorage.getItem('default_model') || all[0]?.id || 'simona-sonnet-4-6' };
            // 也合并 providers 配置的模型（如项目对话使用的 deepseek-v4-flash / glm-5.2 等），
            // 避免 isModelSelectable 把项目模型判定为跨模式而 arm crossModeWarning，导致发送被拦截。
            try {
              const pModels = await getProviderModels();
              if (Array.isArray(pModels) && pModels.length > 0) {
                const known = new Set(all.map((m: any) => m.id));
                const extra = pModels.filter(m => !known.has(m.id)).map(m => ({ id: m.id, name: m.name || m.id, enabled: 1 }));
                if (extra.length > 0) data.all = [...data.all, ...extra];
              }
            } catch (_) {}
          } else {
            // Fallback: load all from providers
            const pModels = await getProviderModels();
            const all = pModels.map(m => ({ id: m.id, name: m.name || m.id, enabled: 1 }));
            data = { all, common: all, fallback_model: all[0]?.id || 'simona-sonnet-4-6' };
          }
        } else {
          data = await getUserModels();
          // Enrich known Simona models with descriptions
          const descMap: Record<string, string> = {
            'simona-opus-4-6': 'Most capable for ambitious work',
            'simona-sonnet-4-6': 'Most efficient for everyday tasks',
            'simona-haiku-4-5-20251001': 'Fastest for quick answers',
          };
          for (const list of [data?.common, data?.all]) {
            if (!Array.isArray(list)) continue;
            for (const m of list) {
              if (descMap[m.id] && !m.description) m.description = descMap[m.id];
            }
          }
          // 合并 providers 配置的模型（如 Sensenova 的 deepseek-v4-flash / glm-5.2 等）
          // 到 modelCatalog.all，让项目对话等使用 providers 模型的会话能被正确识别，
          // 避免 isModelSelectable 判定为跨模式而回退到错误的 Simona 模型。
          try {
            const pModels = await getProviderModels();
            if (Array.isArray(pModels) && pModels.length > 0) {
              const known = new Set((data?.all || []).map((m: any) => m.id));
              const extra = pModels.filter(m => !known.has(m.id)).map(m => ({ id: m.id, name: m.name || m.id, enabled: 1 }));
              if (extra.length > 0) {
                data.all = [...(data.all || []), ...extra];
              }
            }
          } catch (_) {}
        }
        if (cancelled) return;
        setModelCatalog(data);
        if (!viewingIdRef.current) {
          setCurrentModelString(prev => {
            const current = prev || localStorage.getItem('default_model') || 'simona-sonnet-4-6';
            const thinking = true; // 默认开启思考
            const base = stripThinking(current);
            const all: SelectableModel[] = data?.all?.length ? data.all : fallbackCommonModels;
            const preferred = all.find((m: SelectableModel) => m.id === base && Number(m.enabled) === 1);
            if (preferred) return withThinking(base, thinking);
            const fallbackBase = data?.fallback_model
              || all.find((m: SelectableModel) => /sonnet/i.test(m.id) && Number(m.enabled) === 1)?.id
              || all.find((m: SelectableModel) => Number(m.enabled) === 1)?.id
              || base
              || 'simona-sonnet-4-6';
            return withThinking(fallbackBase, thinking);
          });
        }
      } catch {
        // ignore
      }
    };
    loadModels();
    const timer = setInterval(loadModels, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackCommonModels]);

  // 草稿持久化：切换对话 / 打开设置页面时保存，切回时恢复
  const draftKey = activeId || '__new__';
  useEffect(() => {
    const saved = draftsStore.get(draftKey);
    if (saved) {
      setInputText(saved.text);
      setPendingFiles(saved.files);
      textareaHeightVal.current = saved.height;
      // Apply saved height to DOM
      if (inputRef.current) {
        inputRef.current.style.height = `${saved.height}px`;
        inputRef.current.style.overflowY = saved.height >= 316 ? 'auto' : 'hidden';
      }
      draftsStore.delete(draftKey);
    } else {
      setInputText('');
      setPendingFiles([]);
      textareaHeightVal.current = inputBarBaseHeight;
    }
    return () => {
      const text = inputTextRef.current;
      const files = pendingFilesRef.current;
      const height = textareaHeightRef.current;
      if (text.trim() || files.length > 0) {
        draftsStore.set(draftKey, { text, files, height });
      } else {
        draftsStore.delete(draftKey);
      }
    };
  }, [draftKey]);

  // 路由变化时也触发入场动画
  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      setShowEntranceAnimation(true);
      setTimeout(() => setShowEntranceAnimation(false), 800);
    }
  }, [location.pathname]);

  useEffect(() => {
    setUser(getUser());
    // Check subscription status
    getUserUsage().then(usage => {
      const hasSub = !!(usage.plan && usage.plan.status === 'active');
      const hasQuota = usage.token_quota > 0 && usage.token_remaining > 0;
      setHasSubscription(hasSub || hasQuota);
    }).catch(() => setHasSubscription(false));
  }, [activeId]);

  useEffect(() => {
    // Reset state when switching conversations — each conversation has independent streaming
    setPlanMode(false);
    setActiveTasks(new Map());
    setAskUserDialog(null);
    isCreatingRef.current = false;
    viewingIdRef.current = activeId || null;

    // Pre-warm engine when user opens a conversation (init in background before they send)
    if (activeId) warmEngine(activeId);

    if (activeId) {
      // Check if there's a live buffer for this conversation (e.g. streaming in background)
      const buffered = messagesBufferRef.current.get(activeId);
      if (buffered && buffered.length > 0) {
        setMessages(buffered);
        setLoading(isStreaming(activeId));
        // Restore model from server even when using buffer for messages
        const buffConvId = activeId;
        getConversation(buffConvId).then(data => {
          if (data?.model && viewingIdRef.current === buffConvId) {
            setCurrentModelString(isModelSelectable(data.model) ? data.model : resolveModelForNewChat(data.model));
          }
        }).catch(() => {});
      } else if (clusterStreamingRef.current) {
        // 如果正在集群模式流式传输，不要加载对话，保持当前消息
        console.log('[useEffect] Skipping loadConversation because cluster streaming is active (ref)');
        setLoading(true);
      } else {
        setLoading(false);
        loadConversation(activeId);
        // Check if server has an active stream we can reconnect to
        const convId = activeId;
        getStreamStatus(convId).then(status => {
          if (status.active && viewingIdRef.current === convId) {
            setLoading(true);
            addStreaming(convId);
            // Seed buffer from current messages + placeholder
            setMessages(prev => {
              const msgs = prev.length > 0 ? prev : [];
              // Add assistant placeholder if last message isn't one
              if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'assistant') {
                const withPlaceholder = [...msgs, { role: 'assistant', content: '' }];
                messagesBufferRef.current.set(convId, withPlaceholder);
                return withPlaceholder;
              }
              messagesBufferRef.current.set(convId, msgs);
              return msgs;
            });
            const reconnectController = new AbortController();
            abortControllersRef.current.set(convId, reconnectController);
            reconnectStream(
              convId,
              (delta, full) => {
                setMessagesFor(convId, prev => {
                  const newMsgs = [...prev];
                  const lastMsg = newMsgs[newMsgs.length - 1];
                  if (lastMsg && lastMsg.role === 'assistant') { lastMsg.content = full; lastMsg.isThinking = false; }
                  return newMsgs;
                });
              },
              (full) => {
                removeStreaming(convId);
                messagesBufferRef.current.delete(convId);
                if (viewingIdRef.current === convId) setLoading(false);
                abortControllersRef.current.delete(convId);
                setMessagesFor(convId, prev => {
                  const newMsgs = [...prev];
                  const lastMsg = newMsgs[newMsgs.length - 1];
                  if (lastMsg && lastMsg.role === 'assistant') { lastMsg.content = full; lastMsg.isThinking = false; }
                  return newMsgs;
                });
              },
              (err) => {
                removeStreaming(convId);
                messagesBufferRef.current.delete(convId);
                if (viewingIdRef.current === convId) setLoading(false);
                abortControllersRef.current.delete(convId);
              },
              (thinkingDelta, thinkingFull) => {
                setMessagesFor(convId, prev => {
                  const newMsgs = [...prev];
                  const lastMsg = newMsgs[newMsgs.length - 1];
                  if (lastMsg && lastMsg.role === 'assistant') { lastMsg.thinking = thinkingFull; lastMsg.isThinking = true; }
                  return newMsgs;
                });
              },
              (event, message, data) => {
                if (event === 'ask_user' && data) {
                  setAskUserDialog({ request_id: data.request_id, tool_use_id: data.tool_use_id, questions: data.questions || [], answers: {} });
                }
                if (event === 'permission_request' && data) {
                  setPermissionDialog({ request_id: data.request_id, tool_use_id: data.tool_use_id, tool_name: data.tool_name || 'Unknown tool', tool_input: data.tool_input || {} });
                }
                if (event === 'task_event' && data) {
                  setActiveTasks(prev => {
                    const next = new Map(prev);
                    if (data.subtype === 'task_started') next.set(data.task_id, { description: data.description || 'Running task...' });
                    else if (data.subtype === 'task_progress') { const e = next.get(data.task_id); if (e) next.set(data.task_id, { ...e, last_tool_name: data.last_tool_name }); }
                    else if (data.subtype === 'task_notification') next.delete(data.task_id);
                    return next;
                  });
                }
              },
              (toolEvent) => {
                if (toolEvent.type === 'done' && toolEvent.tool_name === 'EnterPlanMode') setPlanMode(true);
                if (toolEvent.type === 'done' && toolEvent.tool_name === 'ExitPlanMode') setPlanMode(false);
                const INTERNAL_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop']);
                if (INTERNAL_TOOLS.has(toolEvent.tool_name || '')) return;
                setMessagesFor(convId, prev => {
                  const newMsgs = [...prev];
                  const lastMsg = newMsgs[newMsgs.length - 1];
                  if (!lastMsg || lastMsg.role !== 'assistant') return prev;
                  const toolCalls = lastMsg.toolCalls || [];
                  if (toolEvent.type === 'start') {
                    let existing = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
                    if (existing) {
                      existing.name = toolEvent.tool_name || existing.name;
                      if (toolEvent.tool_input && Object.keys(toolEvent.tool_input).length > 0) existing.input = toolEvent.tool_input;
                      if (toolEvent.textBefore) existing.textBefore = toolEvent.textBefore;
                    } else {
                      toolCalls.push({ id: toolEvent.tool_use_id, name: toolEvent.tool_name || 'unknown', input: toolEvent.tool_input || {}, status: 'running' as const, textBefore: toolEvent.textBefore || '' });
                    }
                  }
                  else if (toolEvent.type === 'input') {
                    const tc = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
                    if (tc) tc.input = toolEvent.tool_input || {};
                  }
                  else if (toolEvent.type === 'done') {
                    let tc = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
                    if (!tc) { tc = { id: toolEvent.tool_use_id, name: toolEvent.tool_name || 'unknown', input: {}, status: 'done' as const, result: toolEvent.content }; toolCalls.push(tc); }
                    else { tc.status = toolEvent.is_error ? 'error' as const : 'done' as const; tc.result = toolEvent.content; }
                  }
                  lastMsg.toolCalls = toolCalls;
                  return newMsgs;
                });
              },
              reconnectController.signal
            );
          }
        }).catch(() => {});
      }
      getContextSize(activeId).then(data => {
        setContextInfo(data);
        // 自动压缩：超过200万上下文时自动触发
        const limit = 1000000;
        if (data && data.tokens >= limit && !autoCompactTriggered && compactStatus.state === 'idle') {
          setAutoCompactTriggered(true);
          setCompactStatus({ state: 'compacting' });
          compactConversation(activeId).then(async result => {
            await loadConversation(activeId);
            const newContextInfo = await getContextSize(activeId);
            setContextInfo(newContextInfo);
            setCompactStatus({ state: 'done', message: `已压缩 ${result.messagesCompacted} 条消息，节省约 ${result.tokensSaved} tokens` });
            setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
          }).catch(err => {
            console.error('自动压缩失败:', err);
            setCompactStatus({ state: 'error', message: '自动压缩失败' });
            setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
          });
        }
      }).catch(() => { });
      isAtBottomRef.current = true;

      // Handle initialMessage from Project page navigation
      const navState = location.state as any;
      if (navState?.initialMessage) {
        pendingInitialMessageRef.current = navState.initialMessage;
        if (navState.model) setCurrentModelString(navState.model);
        // Clear location state to prevent re-sends on refresh
        navigate(location.pathname, { replace: true, state: {} });
      }
      return;
    }

    setLoading(false);
    setMessages([]);
    setContextInfo(null);
    setAutoCompactTriggered(false);
    setCurrentModelString(resolveModelForNewChat());
  }, [activeId]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const beginStreamSession = useCallback((conversationId: string) => {
    // 按会话计数：同一会话多次发送时 requestId 递增，不同会话互不影响
    const prevId = streamSessionsRef.current.get(conversationId) || 0;
    const nextId = prevId + 1;
    streamSessionsRef.current.set(conversationId, nextId);
    return nextId;
  }, []);

  const isStreamSessionActive = useCallback((conversationId: string, requestId: number) => {
    // 校验"该会话自己的最新请求"是否匹配，而不受其他会话开始的影响
    return streamSessionsRef.current.get(conversationId) === requestId;
  }, []);

  const clearStreamSession = useCallback((conversationId: string, requestId: number) => {
    if (streamSessionsRef.current.get(conversationId) !== requestId) return false;
    streamSessionsRef.current.delete(conversationId);
    return true;
  }, [isStreamSessionActive]);

  const abortStreamSession = useCallback((targetConversationId?: string) => {
    // 未指定目标时，默认停止"当前视图会话"的活跃流，绝不波及后台其他会话
    const trackedConversationId = targetConversationId || viewingIdRef.current || undefined;
    if (!trackedConversationId) return false;

    const controller = abortControllersRef.current.get(trackedConversationId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(trackedConversationId);
      activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
      // SSE 模式：也通知后端杀掉引擎进程
      stopGeneration(trackedConversationId).catch(e => console.error('[Stop] error:', e));
    } else if (pollingRef.current) {
      stopPolling();
      stopGeneration(trackedConversationId).catch(e => console.error('[Stop] error:', e));
    }

    streamSessionsRef.current.delete(trackedConversationId);
    removeStreaming(trackedConversationId);
    if (viewingIdRef.current === trackedConversationId) setLoading(false);
    isCreatingRef.current = false;
    return true;
  }, [stopPolling]);

  // 组件卸载或对话切换时停止轮询
  useEffect(() => {
    return () => { stopPolling(); };
  }, [activeId, stopPolling]);

  // 对话删除前先中止流式请求，避免旧会话的输出串到当前界面
  useEffect(() => {
    const handleConversationDeleting = (evt: Event) => {
      const customEvt = evt as CustomEvent<{ id?: string }>;
      const conversationId = customEvt.detail?.id;
      if (!conversationId) return;
      abortStreamSession(conversationId);
    };

    window.addEventListener('conversationDeleting', handleConversationDeleting as EventListener);
    return () => {
      window.removeEventListener('conversationDeleting', handleConversationDeleting as EventListener);
    };
  }, [abortStreamSession]);

  useEffect(() => {
    // 只在加载中（模型正在生成）或用户刚发送消息时才自动滚动
    // 对话结束后不要自动滚动，避免用户正在查看历史消息时被打断
    if (isAtBottomRef.current && loading && !userScrolledUpRef.current) {
      scrollToBottom('auto');
    }
  }, [messages, loading]);

  // 当输入框高度变化时，如果已经在底部，则保持在底部
  useEffect(() => {
    if (isAtBottomRef.current && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [inputHeight]);

  const handleScroll = () => {
    if (scrollContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
      const isBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 50;
      if (isBottom && userScrolledUpRef.current) {
        // 用户自己滚回了底部，重新启用自动滚动
        userScrolledUpRef.current = false;
      }
      if (!userScrolledUpRef.current) {
        isAtBottomRef.current = isBottom;
      }
      
      // 更新当前可见的section索引
      const messageElements = document.querySelectorAll('[data-message-index]');
      let currentIndex = 0;
      messageElements.forEach((el, idx) => {
        const rect = el.getBoundingClientRect();
        if (rect.top >= 0 && rect.top <= window.innerHeight / 2) {
          currentIndex = idx;
        }
      });
      setCurrentSectionIndex(currentIndex);

      // Android: 滚动时收拢输入框
      if (isAndroidApp) {
        if (!isBottom && !inputCollapsed) {
          setInputCollapsed(true);
        } else if (isBottom && inputCollapsed) {
          setInputCollapsed(false);
        }
      }
    }
  };

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  };

  const scheduleScrollToBottomAfterRender = useCallback((attempts = 6) => {
    const run = (remaining: number) => {
      // 仅尊重用户主动上滚：只要用户没有滚上去，就一直滚到底部。
      // 不再用 isAtBottomRef 判断——长会话的 Markdown/图片/文档卡片会在
      // 首帧后继续撑高高度，首次滚动到底后 handleScroll 会把 isAtBottomRef
      // 置为 false，若在此检查会导致后续补滚全部被中止而停在半途。
      if (userScrolledUpRef.current) return;
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
      if (remaining > 0) {
        requestAnimationFrame(() => run(remaining - 1));
      }
    };

    requestAnimationFrame(() => run(attempts));

    // 某些内容（Markdown、文档卡片、字体回流）会在首帧后继续撑高高度，
    // 仅靠 rAF 可能还会停在上方，因此再补几次延迟滚动。
    // 但必须在每次执行前检查用户是否已经主动滚动了！
    [80, 200, 400, 800, 1200].forEach((delay) => {
      window.setTimeout(() => {
        // Skip if user has scrolled away
        if (userScrolledUpRef.current) return;
        const el = scrollContainerRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      }, delay);
    });
  }, []);

  const loadConversation = async (conversationId: string) => {
    // 如果正在集群模式流式传输，不要覆盖 messages
    if (clusterStreamingRef.current) {
      console.log('[LoadConversation] Skipping load because cluster streaming is active (ref)');
      return;
    }
    
    stopPolling();
    try {
      const data = await getConversation(conversationId);
      // Restore conversation model. If the stored model isn't available in the
      // current user_mode (typical case: user switched modes after the conv was
      // created), DON'T silently fall back — keep showing the original model and
      // arm a cross-mode warning that fires on the next send attempt. The user
      // gets to explicitly choose between (a) keep using the cross-mode model or
      // (b) switch to a model from the current mode.
      if (data.model) {
        const currentMode = (localStorage.getItem('user_mode') === 'selfhosted' ? 'selfhosted' : 'clawparrot') as 'clawparrot' | 'selfhosted';
        const otherMode = currentMode === 'selfhosted' ? 'clawparrot' : 'selfhosted';
        const existingOverride = getCrossModeOverride(conversationId);
        if (isModelSelectable(data.model)) {
          // Available in current mode → just use it.
          setCurrentModelString(data.model);
          setCrossModeWarning(null);
        } else if (existingOverride === otherMode) {
          // User already opted into cross-mode for this conv earlier; keep silent.
          setCurrentModelString(data.model);
          setCrossModeWarning(null);
        } else {
          // Cross-mode mismatch with no prior choice — arm the warning. We keep
          // currentModelString = original model (NOT fallback) so the model
          // selector reflects what the conversation actually uses.
          setCurrentModelString(data.model);
          setCrossModeWarning({
            convId: conversationId,
            originalModel: data.model,
            otherMode,
            fallbackModel: resolveModelForNewChat(data.model),
          });
        }
      }
      // Restore research mode toggle
      setResearchMode(!!data.research_mode);
      const normalizedMessages = (data.messages || []).map((msg: any) => {
        // Normalize attachment field names (bridge-server uses camelCase, component expects snake_case)
        if (msg.attachments && Array.isArray(msg.attachments)) {
          msg.attachments = msg.attachments.map((att: any) => ({
            id: att.id || att.fileId || att.file_id || '',
            file_name: att.file_name || att.fileName || 'file',
            file_type: att.file_type || att.fileType || 'document',
            mime_type: att.mime_type || att.mimeType || '',
            file_size: att.file_size || att.size || 0,
            ...att,
          }));
        }
        return sanitizeInlineArtifactMessage(msg);
      });
      setMessages(normalizedMessages);
      isAtBottomRef.current = true;
      // 切换到新会话时，必须重置用户上滚标记，
      // 否则上一会话中向上滚动留下的 userScrolledUpRef 会让
      // scheduleScrollToBottomAfterRender 的所有补滚被中止，导致切换后停在上方。
      userScrolledUpRef.current = false;
      scheduleScrollToBottomAfterRender();
      setConversationTitle(data.title || '新对话');
      setCurrentProjectId(data.project_id || null);

      // Load project files after setting project ID
      console.log('[LoadConversation] Loading project files, project_id:', data.project_id);
      if (data.project_id) {
        // If conversation has a project, load its files
        console.log('[LoadConversation] Has project, loading files for:', data.project_id);
        getProject(data.project_id).then((projData: any) => {
          console.log('[LoadConversation] Loaded project files:', projData.files?.length || 0);
          setCurrentProjectFiles(projData.files || []);
        }).catch((err) => {
          console.error('[LoadConversation] Failed to load project files:', err);
        });
      } else {
        // If no project, ensure we have files from available projects
        console.log('[LoadConversation] No project, loading all projects');
        getProjects().then((projects: any[]) => {
          console.log('[LoadConversation] Loaded projects:', projects?.length || 0);
          setAvailableProjects(projects || []);
          const projectWithFiles = projects?.find((p: any) => p.files && p.files.length > 0);
          console.log('[LoadConversation] Found project with files:', projectWithFiles?.name, 'files:', projectWithFiles?.files?.length);
          if (projectWithFiles) {
            setSelectedProjectForFiles(projectWithFiles.id);
            setCurrentProjectFiles(projectWithFiles.files || []);
            console.log('[LoadConversation] Set currentProjectFiles:', projectWithFiles.files?.length);
          } else {
            console.log('[LoadConversation] No projects with files found');
          }
        }).catch((err) => {
          console.error('[LoadConversation] Failed to load projects:', err);
        });
      }

      // 检查是否有活跃的后台生成
      try {
        const genStatus = await getGenerationStatus(conversationId);
        if (genStatus.active && genStatus.status === 'generating') {
          // 追加占位 assistant 消息（如果最后一条不是 assistant）
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (
              last &&
              last.role === 'assistant' &&
              !last.content &&
              !genStatus.text &&
              !genStatus.thinking &&
              !(genStatus.documents && genStatus.documents.length > 0) &&
              !genStatus.document
            ) {
              // 已有空占位，更新它
              return prev;
            }
            if (last && last.role === 'assistant') {
              // 更新现有 assistant 消息
              const newMsgs = [...prev];
              newMsgs[newMsgs.length - 1] = applyGenerationState(last, genStatus);
              return newMsgs;
            }
            // 追加新的 assistant 占位
            return [...prev, mergeDocumentsIntoMessage({
              role: 'assistant',
              content: genStatus.text || '',
              thinking: genStatus.thinking || '',
              thinkingSummary: genStatus.thinkingSummary,
              citations: genStatus.citations,
              searchLogs: genStatus.searchLogs,
              isThinking: !genStatus.text && !!genStatus.thinking,
            }, genStatus.document, genStatus.documents)];
          });
          setLoading(true);
          isAtBottomRef.current = true;

          // 启动轮询
          pollingRef.current = setInterval(async () => {
            try {
              const s = await getGenerationStatus(conversationId);
              if (!s.active || s.status !== 'generating') {
                // 生成结束，停止轮询，重新加载最终数据
                stopPolling();
                setLoading(false);
                const final_ = await getConversation(conversationId);
                setMessages((final_.messages || []).map((msg: any) => sanitizeInlineArtifactMessage(msg)));
                isAtBottomRef.current = true;
                scheduleScrollToBottomAfterRender();
                if (final_.title) setConversationTitle(final_.title);
                getContextSize(conversationId).then(data => {
                  setContextInfo(data);
                  const limit = 1000000;
                  if (data && data.tokens >= limit && !autoCompactTriggered && compactStatus.state === 'idle') {
                    setAutoCompactTriggered(true);
                    setCompactStatus({ state: 'compacting' });
                    compactConversation(conversationId).then(async result => {
                      await loadConversation(conversationId);
                      const newContextInfo = await getContextSize(conversationId);
                      setContextInfo(newContextInfo);
                      setCompactStatus({ state: 'done', message: `已压缩 ${result.messagesCompacted} 条消息，节省约 ${result.tokensSaved} tokens` });
                      setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
                    }).catch(err => {
                      console.error('自动压缩失败:', err);
                      setCompactStatus({ state: 'error', message: '自动压缩失败' });
                      setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
                    });
                  }
                }).catch(() => { });
                return;
              }
              // 跨进程轮询：内容在另一个进程，从数据库拉最新消息
              if (s.crossProcess) {
                const fresh = await getConversation(conversationId);
                const freshMsgs = (fresh.messages || []).map((msg: any) => sanitizeInlineArtifactMessage(msg));
                isAtBottomRef.current = true;
                scheduleScrollToBottomAfterRender();
                // 如果数据库里最后一条是 assistant，说明有新内容，更新
                // 否则保留当前显示的内容（助手消息可能还没存到数据库）
                setMessages(prev => {
                  const lastFresh = freshMsgs[freshMsgs.length - 1];
                  const lastPrev = prev[prev.length - 1];
                  if (lastFresh && lastFresh.role === 'assistant') {
                    return freshMsgs;
                  }
                  // 数据库里还没有助手消息，保留当前显示的占位消息
                  if (lastPrev && lastPrev.role === 'assistant') {
                    return prev;
                  }
                  return freshMsgs;
                });
                return;
              }
              // 更新进度
              setMessages(prev => {
                const newMsgs = [...prev];
                const last = newMsgs[newMsgs.length - 1];
                if (last && last.role === 'assistant') {
                  newMsgs[newMsgs.length - 1] = applyGenerationState(last, s);
                }
                return newMsgs;
              });
            } catch (e) {
              console.error('[Polling] error:', e);
              stopPolling();
              setLoading(false);
            }
          }, 1500);
        } else {
          setLoading(false);
        }
      } catch {
        // generation-status 接口失败不影响正常加载
        setLoading(false);
      }
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  };

  const handleModelChange = async (newModelString: string) => {
    if (!isModelSelectable(newModelString)) return;
    setCurrentModelString(newModelString);

    // If in an existing conversation, we should update the conversation's model immediately
    if (activeId && !isCreatingRef.current) {
      try {
        const updated = await updateConversation(activeId, { model: newModelString });
        if (updated?.model) {
          setCurrentModelString(updated.model);
        }
      } catch (err) {
        console.error("Failed to update conversation model", err);
      }
    }
  };

  // Force clear all persona data from localStorage (debug function)
  const handleForceClearPersonaData = () => {
    try {
      // Only clean Linmo residue, NOT all persona data
      const profile = JSON.parse(localStorage.getItem('user_profile') || '{}');
      const userData = JSON.parse(localStorage.getItem('user') || '{}');
      
      let cleaned = false;
      
      // Remove Linmo-specific fields from user_profile
      if (profile.work_function?.includes('林墨') || profile.work_function?.includes('后端架构师')) {
        delete profile.work_function;
        delete profile.personal_preferences;
        localStorage.setItem('user_profile', JSON.stringify(profile));
        cleaned = true;
        console.log('[Persona] Cleaned Linmo residue from user_profile');
      }
      
      // Remove Linmo-specific fields from user
      if (userData.work_function?.includes('林墨') || userData.work_function?.includes('后端架构师')) {
        delete userData.work_function;
        delete userData.personal_preferences;
        localStorage.setItem('user', JSON.stringify(userData));
        cleaned = true;
        console.log('[Persona] Cleaned Linmo residue from user');
      }
      
      // Clean polluted original profiles
      const origProfile = JSON.parse(localStorage.getItem('original_user_profile') || '{}');
      if (origProfile.work_function?.includes('林墨') || origProfile.work_function?.includes('后端架构师')) {
        localStorage.removeItem('original_user_profile');
        localStorage.removeItem('original_user');
        cleaned = true;
        console.log('[Persona] Cleaned polluted original_user_profile');
      }
      
      if (cleaned) {
        alert('已清除林墨残留数据，请刷新页面');
      } else {
        alert('未发现林墨残留数据');
      }
    } catch (err) {
      console.error('[Persona] Failed to clean:', err);
    }
  };
  
  // Handle persona switch
  const handleSwitchPersona = (personaId: string) => {
    setCurrentPersonaId(personaId);
    localStorage.setItem('current_persona_id', personaId);
    setShowPersonaDropdown(false);
    
    // Update user_profile in localStorage so backend receives the new persona settings
    try {
      // Always backup current state before switching (only once)
      if (!localStorage.getItem('original_user_profile')) {
        localStorage.setItem('original_user_profile', localStorage.getItem('user_profile') || '{}');
        localStorage.setItem('original_user', localStorage.getItem('user') || '{}');
        console.log('[Persona] Saved original profile for restore');
      }
      
      if (personaId) {
        const persona = personas.find(p => p.id === personaId);
        if (persona) {
          // Use persona's data directly - NO fallback to old data
          const updatedProfile = {
            ...JSON.parse(localStorage.getItem('user_profile') || '{}'),
            work_function: persona.workFunction,
            personal_preferences: persona.personalPreferences,
          };
          localStorage.setItem('user_profile', JSON.stringify(updatedProfile));
          
          // Also update 'user' key if it exists
          const existingUser = JSON.parse(localStorage.getItem('user') || '{}');
          if (Object.keys(existingUser).length > 0) {
            const updatedUser = {
              ...existingUser,
              work_function: persona.workFunction,
              personal_preferences: persona.personalPreferences,
            };
            localStorage.setItem('user', JSON.stringify(updatedUser));
          }
          
          console.log('[Persona] Switched to:', persona.name, '- work_function:', persona.workFunction ? persona.workFunction.substring(0, 40) : '(empty)');
        }
      } else {
        // "No persona" - restore original profile
        const originalProfile = localStorage.getItem('original_user_profile');
        const originalUser = localStorage.getItem('original_user');
        if (originalProfile) {
          localStorage.setItem('user_profile', originalProfile);
          console.log('[Persona] Restored original user_profile');
        }
        if (originalUser) {
          localStorage.setItem('user', originalUser);
          console.log('[Persona] Restored original user');
        }
      }
    } catch (err) {
      console.error('[Persona] Failed to update profile:', err);
    }
  };

  const handleAttachToProject = async (project: Project) => {
    setShowPlusMenu(false);
    setShowProjectsSubmenu(false);
    if (activeId) {
      if (currentProjectId === project.id) return;
      try {
        await updateConversation(activeId, { project_id: project.id });
        setCurrentProjectId(project.id);
        onNewChat();
        setProjectAddToast(`Added to ${project.name}`);
        setTimeout(() => setProjectAddToast(null), 2500);
      } catch (err) {
        console.error('Failed to add conversation to project', err);
      }
    } else {
      setPendingProjectId(project.id);
      setProjectAddToast(`Will add to ${project.name} on send`);
      setTimeout(() => setProjectAddToast(null), 2500);
    }
  };

  const handleCreateProjectFromMenu = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    try {
      const project = await createProject(name, newProjectDescription.trim());
      setShowNewProjectDialog(false);
      setNewProjectName('');
      setNewProjectDescription('');
      setProjectList(prev => [project, ...prev]);
      // 跳转到项目页面
      navigate(`/projects/${project.id}`);
    } catch (err) {
      console.error('Failed to create project', err);
    }
  };

  // 集群消息发送函数
  const sendClusterMessage = async (message: string) => {
    try {
      setLoading(true);
      
      // 乐观UI：立即显示用户消息
      const tempUserMsg: any = { 
        id: `msg-${Date.now()}-user`,
        role: 'user', 
        content: message, 
        created_at: new Date().toISOString(),
      };
      console.log('[Cluster] Adding user message:', tempUserMsg);
      setMessages(prev => {
        const newMessages = [...prev, tempUserMsg];
        console.log('[Cluster] Messages after adding user:', newMessages.length, 'messages');
        return newMessages;
      });
      
      // 等待 React 状态更新完成
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 强制滚动到底部，确保用户消息可见
      isAtBottomRef.current = true;
      // 多次滚动确保位置正确
      scrollToBottom('auto');
      setTimeout(() => scrollToBottom('auto'), 100);
      setTimeout(() => scrollToBottom('auto'), 300);
      
      // 初始化集群状态（仅用于内部跟踪）
      clusterStreamingRef.current = true; // Set ref to prevent loadConversation
      setClusterState({
        isActive: true,
        agentCount: clusterConfig.agentCount,
        agents: [],
        aggregatedResult: '',
        currentPhase: 'planning',
      });

      // 获取用户模式和token
      const userMode = localStorage.getItem('user_mode') || 'clawparrot';
      const authToken = localStorage.getItem('auth_token') || '';
      const apiKey = localStorage.getItem('SIMONA_API_KEY') || '';
      const baseUrl = localStorage.getItem('SIMONA_BASE_URL') || '';

      // 检查是否有有效的conversation_id
      let conversationId = activeId;
      
      // 如果没有activeId或activeId不存在，先创建一个新对话
      if (!conversationId) {
        console.log('[Cluster] No active conversation, creating new one...');
        // 使用当前选择的模型创建对话，避免cross-mode警告
        const newConv = await createConversation('新对话', currentModelString);
        if (newConv && newConv.id) {
          conversationId = newConv.id;
          console.log('[Cluster] Created new conversation:', conversationId, 'with model:', currentModelString);
          // 延迟导航，确保SSE请求已经发送
          setTimeout(() => {
            navigate(`/chat/${conversationId}`);
            console.log('[Cluster] Navigated to new conversation');
          }, 500);
        } else {
          throw new Error('无法创建对话');
        }
      }

      // 使用固定的API地址（支持桌面端和网页端）
      const apiBase = window.location.protocol === 'file:' 
        ? 'http://127.0.0.1:30080' 
        : window.location.origin;
      
      console.log('[Cluster] Sending request to:', `${apiBase}/api/cluster-chat`);
      console.log('[Cluster] Config:', { conversation_id: conversationId, agent_count: clusterConfig.agentCount || 3 });

      // 创建 AbortController 用于停止集群对话
      const controller = new AbortController();
      clusterAbortControllerRef.current = controller;

      // 调用API
      const response = await fetch(`${apiBase}/api/cluster-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          conversation_id: conversationId,
          message,
          cluster_config: clusterConfig,
          env_token: apiKey,
          env_base_url: baseUrl,
          user_mode: userMode,
          system_prompt: '', // 可以后续从设置中获取
          user_profile: null, // 可以后续从用户设置中获取
          agent_mode_enabled: true,
        }),
        signal: controller.signal,
      });

      console.log('[Cluster] Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error('[Cluster] Error response:', errorText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // 处理SSE流
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is null');
      }
      
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const match = line.match(/^data: (.+)$/s);
          if (match) {
            try {
              const event = JSON.parse(match[1]);
              console.log('[Cluster Event]', event.type, event);
              handleClusterEvent(event);
            } catch (e) {
              console.error('Failed to parse cluster event:', e);
            }
          }
        }
      }

    } catch (error) {
      // 清除 controller
      clusterAbortControllerRef.current = null;
      
      console.error('Cluster chat error:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      // 如果是被中止的，不显示错误消息
      if (error.name === 'AbortError') {
        console.log('[Cluster] Chat aborted by user');
        setLoading(false);
        setClusterState(null);
        return;
      }
      // 添加错误消息到对话
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `❌ 蜂群执行失败: ${errorMsg}`,
        timestamp: new Date().toISOString(),
      }]);
      setLoading(false);
      setClusterState(null);
    } finally {
      // 确保清除 controller
      clusterAbortControllerRef.current = null;
    }
  };

  // 处理集群事件
  const handleClusterEvent = (event: any) => {
    switch (event.type) {
      case 'cluster_start':
        setClusterState(prev => prev ? {
          ...prev,
          currentPhase: event.phase || 'planning',
        } : null);
        break;

      case 'phase_change':
        setClusterState(prev => prev ? {
          ...prev,
          currentPhase: event.phase,
        } : null);
        console.log('[Cluster] Phase changed to:', event.phase, '-', event.message);
        break;

      case 'agent_start':
        // 为每个Agent创建独立的消息占位符
        const agentMsg: any = {
          id: `msg-${event.agent_id}`,
          role: 'assistant',
          content: '',
          thinking: '',
          timestamp: new Date().toISOString(),
          metadata: {
            cluster_agent: true,
            agent_id: event.agent_id,
            agent_name: event.agent_name,
            agent_model: event.model,
          },
        };
        
        console.log('[Cluster] Creating message for agent:', event.agent_id, event.agent_name);
        setMessages(msgs => {
          console.log('[Cluster] Current messages count:', msgs.length);
          const newMsgs = [...msgs, agentMsg];
          console.log('[Cluster] New messages count:', newMsgs.length);
          return newMsgs;
        });
        
        setClusterState(prev => {
          if (!prev) return prev;
          
          const newAgent: AgentState = {
            id: event.agent_id,
            name: event.agent_name,
            modelId: event.model,
            status: 'running',
            startTime: Date.now(),
            content: '',
            progress: 0,
          };

          return {
            ...prev,
            agents: [...prev.agents, newAgent],
          };
        });
        break;

      case 'content_block_delta':
        // 如果后端在delta事件中携带agent_id
        if (event.agent_id) {
          const deltaType = event.delta?.type;
          console.log('[Cluster Delta] Received delta for agent:', event.agent_id, 'type:', deltaType, 'length:', (event.delta?.text || event.delta?.thinking || '').length);
          
          setMessages(msgs => {
            const newMsgs = [...msgs];
            let agentMsgIndex = newMsgs.findIndex(
              msg => msg.metadata?.cluster_agent && msg.metadata.agent_id === event.agent_id
            );
            
            console.log('[Cluster Delta] Found message index:', agentMsgIndex, 'total messages:', newMsgs.length);
            
            // 如果找不到消息，创建一个（处理agent_start和delta的竞态条件）
            if (agentMsgIndex === -1) {
              console.warn('[Cluster Delta] Message not found, creating new one for agent:', event.agent_id);
              const newAgentMsg: any = {
                id: `msg-${event.agent_id}`,
                role: 'assistant',
                content: '',
                thinking: '',
                timestamp: new Date().toISOString(),
                metadata: {
                  cluster_agent: true,
                  agent_id: event.agent_id,
                  agent_name: event.agent_name || '',
                  agent_model: event.model || '',
                },
              };
              newMsgs.push(newAgentMsg);
              agentMsgIndex = newMsgs.length - 1;
              console.log('[Cluster Delta] Created new message at index:', agentMsgIndex);
            }
            
            // 根据delta类型追加到不同字段
            if (deltaType === 'thinking_delta' && event.delta?.thinking) {
              // 思考内容追加到thinking字段
              const currentThinking = newMsgs[agentMsgIndex].thinking || '';
              newMsgs[agentMsgIndex] = {
                ...newMsgs[agentMsgIndex],
                thinking: currentThinking + event.delta.thinking,
              };
              console.log('[Cluster Delta] Appending thinking to agent', event.agent_id, '- new thinking length:', newMsgs[agentMsgIndex].thinking.length);
            } else if (deltaType === 'text_delta' && event.delta?.text) {
              // 文本内容追加到content字段
              const currentContent = newMsgs[agentMsgIndex].content || '';
              newMsgs[agentMsgIndex] = {
                ...newMsgs[agentMsgIndex],
                content: currentContent + event.delta.text,
              };
              console.log('[Cluster Delta] Appending text to agent', event.agent_id, '- new content length:', newMsgs[agentMsgIndex].content.length);
            }
            
            return newMsgs;
          });

          // 更新clusterState中的agent内容（用于内部跟踪）
          setClusterState(prev => {
            if (!prev) return prev;
            
            return {
              ...prev,
              agents: prev.agents.map(agent => {
                if (agent.id === event.agent_id) {
                  if (deltaType === 'thinking_delta' && event.delta?.thinking) {
                    return { ...agent, content: agent.content }; // thinking doesn't go to content
                  } else if (deltaType === 'text_delta' && event.delta?.text) {
                    return { ...agent, content: agent.content + event.delta.text };
                  }
                }
                return agent;
              }),
            };
          });
        }
        break;

      case 'agent_complete':
        setClusterState(prev => {
          if (!prev) return prev;
          
          return {
            ...prev,
            agents: prev.agents.map(agent =>
              agent.id === event.agent_id
                ? { 
                    ...agent, 
                    status: 'completed', 
                    endTime: Date.now(),
                    content: event.content_preview || agent.content,
                  }
                : agent
            ),
          };
        });
        break;

      case 'agent_error':
        setClusterState(prev => {
          if (!prev) return prev;
          
          return {
            ...prev,
            agents: prev.agents.map(agent =>
              agent.id === event.agent_id
                ? { 
                    ...agent, 
                    status: 'error', 
                    endTime: Date.now(),
                    error: event.error,
                  }
                : agent
            ),
          };
        });
        break;

      case 'aggregation_start':
        setClusterState(prev => prev ? {
          ...prev,
          currentPhase: 'synthesizing',
        } : null);
        break;

      case 'cluster_complete':
        // 蜂群执行完成，不添加总结消息
        setLoading(false);
        clusterStreamingRef.current = false; // Clear ref
        setClusterState(null); // 清除集群状态
        
        // 不需要重新加载，前端已经有完整的消息流
        // if (activeId) {
        //   console.log('[Cluster] Reloading conversation after cluster complete');
        //   setTimeout(() => {
        //     loadConversation(activeId);
        //   }, 100);
        // }
        
        // 清空输入框和重置高度
        setInputText('');
        setPendingFiles([]);
        textareaHeightVal.current = inputBarBaseHeight;
        break;

      case 'message_stop':
        setLoading(false);
        // 实时更新上下文消耗
        if (activeId) {
          getContextSize(activeId).then(data => {
            setContextInfo(data);
            // 检查是否需要自动压缩
            const limit = 1000000;
            if (data && data.tokens >= limit && !autoCompactTriggered && compactStatus.state === 'idle') {
              setAutoCompactTriggered(true);
              setCompactStatus({ state: 'compacting' });
              compactConversation(activeId).then(async result => {
                await loadConversation(activeId);
                const newContextInfo = await getContextSize(activeId);
                setContextInfo(newContextInfo);
                setCompactStatus({ state: 'done', message: `已压缩 ${result.messagesCompacted} 条消息，节省约 ${result.tokensSaved} tokens` });
                setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
              }).catch(err => {
                console.error('自动压缩失败:', err);
                setCompactStatus({ state: 'error', message: '自动压缩失败' });
                setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
              });
            }
          }).catch(() => {});
        }
        break;

      case 'usage_update':
        // 实时更新上下文消耗
        if (event.total_tokens) {
          setContextInfo({ tokens: event.total_tokens, limit: 1000000 });
          // 检查是否需要自动压缩
          const limit = 1000000;
          if (event.total_tokens >= limit && !autoCompactTriggered && compactStatus.state === 'idle' && activeId) {
            setAutoCompactTriggered(true);
            setCompactStatus({ state: 'compacting' });
            compactConversation(activeId).then(async result => {
              await loadConversation(activeId);
              const newContextInfo = await getContextSize(activeId);
              setContextInfo(newContextInfo);
              setCompactStatus({ state: 'done', message: `已压缩 ${result.messagesCompacted} 条消息，节省约 ${result.tokensSaved} tokens` });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
            }).catch(err => {
              console.error('自动压缩失败:', err);
              setCompactStatus({ state: 'error', message: '自动压缩失败' });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
            });
          }
        }
        break;

      case 'error':
        const errorMsg = event.error || 'Unknown error';
        setMessages(msgs => [...msgs, { 
          role: 'assistant', 
          content: `❌ 蜂群执行错误: ${errorMsg}`,
          timestamp: new Date().toISOString(),
        }]);
        setLoading(false);
        setClusterState(null);
        break;
    }
  };

  const handleSend = async (overrideText?: string) => {
    const effectiveText = (typeof overrideText === 'string') ? overrideText : inputText;
    
    // 对话模式：简单对话，只启用网络搜索
    const isDialogMode = dialogMode === 'chat';
    console.log('[MainContent] Dialog mode:', dialogMode, 'isDialogMode:', isDialogMode);
    
    // 检查是否启用集群模式
    if (clusterEnabled && clusterConfig.agentCount && clusterConfig.agentCount >= 2) {
      // 使用集群模式
      await sendClusterMessage(effectiveText);
      return;
    }
    
    // Skill slug is already in the text (inserted when selected from menu)
    setSelectedSkill(null);
    const hasFiles = pendingFiles.some(f => f.status === 'done');
    const hasErrorFiles = pendingFiles.some(f => f.status === 'error');
    if ((!effectiveText.trim() && !hasFiles) || loading) {
      if (!loading && !effectiveText.trim() && !hasFiles && hasErrorFiles) {
        alert('有文件上传失败，请先删除失败文件后再发送');
      }
      return;
    }
        const isUploading = pendingFiles.some(f => f.status === 'uploading');
    if (isUploading) {
      alert('文件仍在上传中，请稍等完成后再发送');
      return;
    }

    // Clawparrot login gate: Electron users in clawparrot mode without a
    // gateway API key get prompted to login on first send. Replaces the old
    // hard redirect to /login at app start — users can now explore the app
    // freely before deciding to login or switch modes.
    const isElectronApp = !!(window as any).electronAPI?.isElectron;
    const userMode = localStorage.getItem('user_mode');
    const hasGatewayKey = localStorage.getItem('SIMONA_API_KEY') && localStorage.getItem('gateway_user');
    // 仅当明确处于 Clawparrot 模式（user_mode === 'clawparrot'）且未登录 gateway 时才提示登录，
    // 与 App.tsx 的 authValid 判定保持一致。固定模式（deepseek/sensenova，user_mode 为空）
    // 与 selfhosted 模式都不应被此登录门拦截，否则每次发送都会弹出全屏登录弹窗遮挡输入框。
    if (isElectronApp && userMode === 'clawparrot' && !hasGatewayKey) {
      pendingLoginSendRef.current = () => handleSend(effectiveText);
      setShowLoginRequired(true);
      return;
    }

    // Cross-mode warning now disabled（跨模式弹窗已在下方 UI 中禁用）。
    // 之前这里仍会拦截发送并 defer 到 pendingCrossModeSendRef，而弹窗被禁用后
    // 该回调永远不会触发 → 一旦 crossModeWarning 被 arm，后续消息永远发不出去。
    // 因此这里不再拦截，直接放行；后端会按对话本身保存的模型路由。
    // 若模型真正不可用，后端会返回明确错误，而不是前端静默吞掉发送。

    const userMessageText = effectiveText;
    setInputText(""); // Clear input

    // 收集已上传的附件（默认全部启用）
    const uploadedFiles = pendingFiles.filter(f => f.status === 'done' && f.fileId);
    const githubFiles = pendingFiles.filter(f => f.status === 'done' && f.source === 'github');
    const uploadedPayload = uploadedFiles.map(f => ({ fileId: f.fileId!, fileName: f.fileName, fileType: f.fileType, mimeType: f.mimeType, size: f.size }));
    const githubPayload = githubFiles.map(f => ({
      fileId: `github:${f.ghRepo || f.fileName}`,
      fileName: f.ghRepo || f.fileName,
      fileType: 'github' as any,
      mimeType: 'application/x-github',
      size: 0,
      source: 'github',
      ghRepo: f.ghRepo,
      ghRef: f.ghRef,
    }));
    
    // 收集已启用的项目文件
    const enabledProjectFiles = currentProjectFiles.filter((f: any) => f.enabled);
    const projectFilesPayload = enabledProjectFiles.map((f: any) => ({
      fileId: f.id,
      fileName: f.file_name || f.name,
      fileType: f.file_type || 'document',
      mimeType: f.mime_type || '',
      size: f.file_size || 0,
      source: 'project',
      projectId: currentProjectId || selectedProjectForFiles,
    }));
    
    const attachmentsPayload = (uploadedPayload.length + githubPayload.length + projectFilesPayload.length) > 0
      ? [...uploadedPayload, ...githubPayload, ...projectFilesPayload]
      : null;

    // 构建乐观 UI 的附件数据
    const optimisticAttachments: any[] = uploadedFiles.map(f => ({
      id: f.fileId!,
      file_type: f.fileType || 'text',
      file_name: f.fileName,
      mime_type: f.mimeType,
      file_size: f.size,
      line_count: f.lineCount,
    }));
    for (const g of githubFiles) {
      optimisticAttachments.push({
        id: `github:${g.ghRepo || g.fileName}`,
        file_type: 'github',
        file_name: g.ghRepo || g.fileName,
        mime_type: 'application/x-github',
        file_size: 0,
        source: 'github',
        gh_repo: g.ghRepo,
        gh_ref: g.ghRef,
      });
    }
    // 添加项目文件到乐观 UI
    for (const pf of enabledProjectFiles) {
      optimisticAttachments.push({
        id: pf.id,
        file_type: pf.file_type || 'document',
        file_name: pf.file_name || pf.name,
        mime_type: pf.mime_type || '',
        file_size: pf.file_size || 0,
        source: 'project',
      });
    }
    // 清空 pendingFiles 并释放预览 URL
    pendingFiles.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    setPendingFiles([]);
    draftsStore.delete(activeId || '__new__');

    // 重置 textarea 高度
    textareaHeightVal.current = inputBarBaseHeight;
    if (inputRef.current) {
      inputRef.current.style.height = `${inputBarBaseHeight}px`;
      inputRef.current.style.overflowY = 'hidden';
    }

    // Optimistic UI: Add user message immediately
    const tempUserMsg: any = { role: 'user', content: userMessageText, created_at: new Date().toISOString() };
    if (optimisticAttachments.length > 0) {
      tempUserMsg.has_attachments = 1;
      tempUserMsg.attachments = optimisticAttachments;
    }
    setMessages(prev => [...prev, tempUserMsg]);

    // Force scroll to bottom and track state
    isAtBottomRef.current = true;
    setTimeout(() => scrollToBottom('auto'), 50);

    // Prepare assistant message placeholder
    const assistantMsgIndex = messages.length + 1;
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    let conversationId = activeId;

    // If no ID, create conversation first
    if (!conversationId) {
      isCreatingRef.current = true; // Block useEffect fetch
      try {
        const modelForCreate = isModelSelectable(currentModelString)
          ? currentModelString
          : resolveModelForNewChat(currentModelString);
        if (modelForCreate !== currentModelString) {
          setCurrentModelString(modelForCreate);
        }
        // 不传临时标题，让后端生成
        console.log("Creating conversation with model:", modelForCreate);
        const newConv = await createConversation(undefined, modelForCreate, { research_mode: researchMode });
        console.log("Created conversation response:", newConv);

        if (!newConv || !newConv.id) {
          throw new Error("Invalid conversation response from server");
        }

        conversationId = newConv.id;
        console.log("New Conversation ID:", conversationId);
        // Attach to pending project if user chose one before sending
        if (pendingProjectId) {
          try {
            await updateConversation(conversationId!, { project_id: pendingProjectId });
            setCurrentProjectId(pendingProjectId);
          } catch (e) {
            console.error('Failed to attach new conversation to project', e);
          }
          setPendingProjectId(null);
        }
        warmEngine(conversationId); // Pre-warm engine while user waits

        // Use React Router navigate so useParams stays in sync with the URL
        // isCreatingRef prevents the activeId effect from reloading during streaming
        navigate(`/chat/${conversationId}`, { replace: true });
        if (newConv.model) {
          setCurrentModelString(newConv.model);
        }
        setConversationTitle(newConv.title || '新对话');

        onNewChat(); // Refresh sidebar
      } catch (err: any) {
        console.error("Failed to create conversation", err);
        isCreatingRef.current = false;
        setMessages(prev => {
          const newMsgs = [...prev];
          // Find the last assistant message (placeholder) and update it
          if (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role === 'assistant') {
            newMsgs[newMsgs.length - 1].content = "Error: Failed to create conversation. " + (err.message || err);
          }
          return newMsgs;
        });
        return;
      }
    }

    // Call streaming API — seed buffer with current messages so background streaming works
    messagesBufferRef.current.set(conversationId!, [...messages, tempUserMsg, { role: 'assistant', content: '' }]);
    const controller = new AbortController();
    const streamRequestId = beginStreamSession(conversationId!);
    abortControllersRef.current.set(conversationId!, controller);
    setLoading(true);
    addStreaming(conversationId!);
    activeRequestCountRef.current += 1;
    
    await sendMessage(
      conversationId!,
      userMessageText,
      attachmentsPayload,
      (delta, full) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = full;
            lastMsg.isThinking = false; // Switch to text mode
          }
          return newMsgs;
        });
      },
      (full) => {
        // Always clean up streaming state and request count, even if session changed
        removeStreaming(conversationId!);
        messagesBufferRef.current.delete(conversationId!);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        if (viewingIdRef.current === conversationId) setLoading(false);
        abortControllersRef.current.delete(conversationId!);
        isCreatingRef.current = false; // Reset flag
        clearStreamSession(conversationId!, streamRequestId);
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = full;
            lastMsg.isThinking = false;
          }
          return newMsgs;
        });
        setTimeout(() => forceSyncArtifactsRef.current?.(), 100);

        // Refresh conversation to get generated title (if any)
        // 标题生成是异步的，可能需要几秒钟，所以需要延迟轮询
        if (conversationId) {
          const refreshTitle = async () => {
            try {
              const data = await getConversation(conversationId);
              console.log('[MainContent] Polling title for', conversationId, ':', data?.title);
              if (data && data.title) {
                // 后台会话完成时侧边栏标题要刷新，但不要覆盖当前视图的标题显示
                if (viewingIdRef.current === conversationId) setConversationTitle(data.title);
                // 使用 CustomEvent 通知侧边栏刷新，避免触发 resetKey 变化
                window.dispatchEvent(new CustomEvent('conversationTitleUpdated'));
              }
            } catch (err) {
              console.error('[MainContent] Error polling title:', err);
            }
          };

          // 立即刷新一次
          refreshTitle();
          // 3秒后再刷新一次（此时标题生成应该已完成）
          setTimeout(refreshTitle, 3000);
          // 6秒后再刷新一次（备用）
          setTimeout(refreshTitle, 6000);
        }
        // 刷新上下文消耗显示
        if (conversationId) {
          getContextSize(conversationId).then(data => {
            console.log('[ContextSize] onDone 更新:', data);
            // 后台会话完成时不要覆盖当前视图的 context 显示
            if (viewingIdRef.current === conversationId) setContextInfo(data);
          }).catch(err => {
            console.error('[ContextSize] onDone 更新失败:', err);
          });
        }
      },
      (err) => {
        // Always clean up streaming state and request count, even if session changed
        removeStreaming(conversationId!);
        messagesBufferRef.current.delete(conversationId!);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        if (viewingIdRef.current === conversationId) setLoading(false);
        abortControllersRef.current.delete(conversationId!);
        isCreatingRef.current = false;
        clearStreamSession(conversationId!, streamRequestId);
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          if (newMsgs[newMsgs.length - 1] && newMsgs[newMsgs.length - 1].role === 'assistant') {
            newMsgs[newMsgs.length - 1].content = formatChatError(err);
            newMsgs[newMsgs.length - 1].isThinking = false;
          }
          return newMsgs;
        });
        setTimeout(() => forceSyncArtifactsRef.current?.(), 100);
      },
      (thinkingDelta, thinkingFull) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.thinking = thinkingFull;
            lastMsg.isThinking = true;
            delete lastMsg.searchStatus;
          }
          return newMsgs;
        });
      },
      (event, message, data) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        // Handle metadata (update user message ID)
        if (event === 'metadata' && data && data.user_message_id) {
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            const userIdx = newMsgs.length - 2;
            if (userIdx >= 0 && newMsgs[userIdx].role === 'user') {
              newMsgs[userIdx] = { ...newMsgs[userIdx], id: data.user_message_id };
            }
            return newMsgs;
          });
        }
        // Handle system/status events (e.g. web search status)
        if (event === 'status' && message) {
          if (!isSearchStatusMessage(message)) return;
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.searchStatus = message;
              lastMsg._contentLenBeforeSearch = (lastMsg.content || '').length;
            }
            return newMsgs;
          });
        }
        // Handle thinking summary
        if (event === 'thinking_summary' && message) {
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.thinking_summary = message;
            }
            return newMsgs;
          });
        }
        // Handle usage update
        if (event === 'usage_update' && data) {
          // 仅当前视图会话更新 context 显示与自动压缩，避免后台会话的 token 事件覆盖/拖累当前视图
          const isCurrentView = viewingIdRef.current === conversationId;
          if (isCurrentView) setContextInfo({ tokens: data.total_tokens, limit: 1000000 });
          const limit = 1000000;
          if (isCurrentView && data.total_tokens >= limit && !autoCompactTriggered && compactStatus.state === 'idle' && activeId) {
            setAutoCompactTriggered(true);
            setCompactStatus({ state: 'compacting' });
            compactConversation(activeId).then(async result => {
              await loadConversation(activeId);
              const newContextInfo = await getContextSize(activeId);
              setContextInfo(newContextInfo);
              setCompactStatus({ state: 'done', message: `已压缩 ${result.messagesCompacted} 条消息，节省约 ${result.tokensSaved} tokens` });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
            }).catch(err => {
              console.error('自动压缩失败:', err);
              setCompactStatus({ state: 'error', message: '自动压缩失败' });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
            });
          }
        }
        // Handle auto compaction progress — 仅当前视图会话显示/处理，后台会话的 compact 事件不污染当前视图
        if (event === 'compaction_start') {
          if (viewingIdRef.current === conversationId) setCompactStatus({ state: 'compacting' });
        }
        if (event === 'compaction_done') {
          if (viewingIdRef.current === conversationId) {
            if (data && data.messagesCompacted > 0) {
              setCompactStatus({ state: 'done', message: `Compacted ${data.messagesCompacted} messages, saved ~${data.tokensSaved} tokens` });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
            } else {
              setCompactStatus({ state: 'idle' });
            }
          }
        }
        // Handle compact_boundary from engine auto-compact during normal chat
        if (event === 'compact_boundary') {
          if (viewingIdRef.current !== conversationId) return;
          const meta = data?.compact_metadata || {};
          const preTokens = meta.pre_tokens || 0;
          const saved = preTokens ? Math.round(preTokens * 0.7) : 0;
          setCompactStatus({ state: 'done', message: saved > 0 ? `Auto-compacted, saved ~${saved} tokens` : 'Context auto-compacted' });
          setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
          // Reload messages to reflect compacted state
          if (activeId) {
            loadConversation(activeId);
            getContextSize(activeId).then(setContextInfo).catch(() => {});
          }
          setAutoCompactTriggered(false);
        }
        if (event === 'context_size' && data) {
          // 后台会话的 context_size 事件不覆盖当前视图的 context 显示
          if (viewingIdRef.current !== conversationId) return;
          setContextInfo({ tokens: data.tokens, limit: data.limit });
          // SSE流式更新时也检查自动压缩
          const limit = 1000000;
          const id = activeId || conversationId;
          if (id && data && data.tokens >= limit && !autoCompactTriggered && compactStatus.state === 'idle') {
            setAutoCompactTriggered(true);
            setCompactStatus({ state: 'compacting' });
            compactConversation(id).then(async result => {
              await loadConversation(id);
              const newContextInfo = await getContextSize(id);
              setContextInfo(newContextInfo);
              setCompactStatus({ state: 'done', message: `已压缩 ${result.messagesCompacted} 条消息，节省约 ${result.tokensSaved} tokens` });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
            }).catch(err => {
              console.error('自动压缩失败:', err);
              setCompactStatus({ state: 'error', message: '自动压缩失败' });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
            });
          }
        }
        if (event === 'tool_text_offset' && data && data.offset != null) {
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.toolTextEndOffset = data.offset;
            }
            return newMsgs;
          });
        }
        if (event && event.startsWith('research_')) {
          // research 状态只反映在当前视图会话上，后台会话的 research 事件不污染当前视图
          if (viewingIdRef.current === conversationId) {
            setMessages(prev => applyResearchEvent(prev, event, data));
          }
        }
        // AskUserQuestion — engine needs user input
        if (event === 'ask_user' && data) {
          setAskUserDialog({
            request_id: data.request_id,
            tool_use_id: data.tool_use_id,
            questions: data.questions || [],
            answers: {},
          });
        }
        // Tool permission request — engine wants user to approve tool execution
        if (event === 'permission_request' && data) {
          setPermissionDialog({
            request_id: data.request_id,
            tool_use_id: data.tool_use_id,
            tool_name: data.tool_name || 'Unknown tool',
            tool_input: data.tool_input || {},
          });
        }
        // Task/Agent progress
        if (event === 'task_event' && data) {
          setActiveTasks(prev => {
            const next = new Map(prev);
            if (data.subtype === 'task_started') {
              next.set(data.task_id, { description: data.description || 'Running task...' });
            } else if (data.subtype === 'task_progress') {
              const existing = next.get(data.task_id);
              if (existing) {
                next.set(data.task_id, { ...existing, last_tool_name: data.last_tool_name, summary: data.summary });
              }
            } else if (data.subtype === 'task_notification') {
              next.delete(data.task_id);
            }
            return next;
          });
        }
      },
      (sources, query, tokens) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        // Handle search_sources — collect citation sources
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            const existing = lastMsg.citations || [];

            // 去重合并
            const existingUrls = new Set(existing.map((s: any) => s.url));
            const newSources = sources.filter((s: any) => !existingUrls.has(s.url));
            lastMsg.citations = [...existing, ...newSources];

            if (query) {
              const logs = lastMsg.searchLogs || [];
              // 检查是否已存在相同的 query
              const existingLogIndex = logs.findIndex((log: any) => log.query === query);
              if (existingLogIndex !== -1) {
                // 更新现有 log 的 results 和 tokens
                const existingLog = logs[existingLogIndex];
                const currentResults = existingLog.results || [];
                const currentUrls = new Set(currentResults.map((r: any) => r.url));
                const uniqueNewResults = sources.filter((s: any) => !currentUrls.has(s.url));
                existingLog.results = [...currentResults, ...uniqueNewResults];
                if (tokens !== undefined) {
                  existingLog.tokens = tokens;
                }
              } else {
                // 添加新 log
                logs.push({ query, results: sources, tokens });
              }
              lastMsg.searchLogs = logs;
            }
          }
          return newMsgs;
        });
      },
      (doc) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentsIntoMessage(newMsgs[lastIdx], doc);
          }
          return newMsgs;
        });
      },
      (draft) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentDraftIntoMessage(newMsgs[lastIdx], draft);
          }
          return newMsgs;
        });
      },
      async (data) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        // Handle code_execution / code_result events
        if (data.type === 'code_execution') {
          // 收到代码执行请求 — 更新消息状态（按会话隔离）+ 在 Pyodide 中执行
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.codeExecution = {
                code: data.code || '',
                status: 'running' as const,
                stdout: '',
                stderr: '',
                images: [],
                error: null,
              };
            }
            return newMsgs;
          });

          // 构建文件列表（附件 URL）
          const authToken = localStorage.getItem('auth_token') || '';
          const files = (data.files || []).map((f: any) => ({
            name: f.name,
            url: (() => {
              const baseUrl = getAttachmentUrl(f.id);
              if (!authToken) return baseUrl;
              return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}`;
            })(),
          }));

          try {
            const result = await executeCode(data.code || '', files, data.executionId);
            // 发送结果回后端
            await sendCodeResult(data.executionId, result);
          } catch (e: any) {
            // 发送错误结果回后端
            await sendCodeResult(data.executionId, {
              stdout: '',
              stderr: '',
              images: [],
              error: e.message || 'Pyodide 执行失败',
            });
          }
        }

        if (data.type === 'code_result') {
          // 收到执行结果 — 更新消息状态（按会话隔离）
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.codeExecution) {
              lastMsg.codeExecution = {
                ...lastMsg.codeExecution,
                status: data.error ? 'error' as const : 'done' as const,
                stdout: data.stdout || '',
                stderr: data.stderr || '',
                images: data.images || [],
                error: data.error || null,
              };
            }
            return newMsgs;
          });
        }
      },
      // Handle tool use events from SDK
      (toolEvent) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;

        // Track plan mode from tool events
        if (toolEvent.type === 'done' && toolEvent.tool_name === 'EnterPlanMode') setPlanMode(true);
        if (toolEvent.type === 'done' && toolEvent.tool_name === 'ExitPlanMode') setPlanMode(false);

        // Don't add internal tools to UI tool list
        const INTERNAL_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop']);
        if (INTERNAL_TOOLS.has(toolEvent.tool_name || '')) return;

        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (!lastMsg || lastMsg.role !== 'assistant') return prev;

          const toolCalls = lastMsg.toolCalls || [];

          if (toolEvent.type === 'start') {
            // Dedupe by id (we may receive a placeholder tool_use_start before
            // the input has finished streaming, then a tool_use_input later)
            let existing = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
            if (existing) {
              existing.name = toolEvent.tool_name || existing.name;
              if (toolEvent.tool_input && Object.keys(toolEvent.tool_input).length > 0) existing.input = toolEvent.tool_input;
              if (toolEvent.textBefore) existing.textBefore = toolEvent.textBefore;
            } else {
              toolCalls.push({
                id: toolEvent.tool_use_id,
                name: toolEvent.tool_name || 'unknown',
                input: toolEvent.tool_input || {},
                status: 'running' as const,
                textBefore: toolEvent.textBefore || '',
              });
            }
          } else if (toolEvent.type === 'input') {
            // Update an existing tool's input after the JSON has fully streamed
            const tc = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
            if (tc) tc.input = toolEvent.tool_input || {};
          } else if (toolEvent.type === 'done') {
            let tc = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
            if (!tc) {
              // tool_use_start was missed — back-fill the entry so the card still renders
              tc = { id: toolEvent.tool_use_id, name: toolEvent.tool_name || 'unknown', input: {}, status: 'done' as const, result: toolEvent.content };
              toolCalls.push(tc);
            } else {
              tc.status = toolEvent.is_error ? 'error' as const : 'done' as const;
              tc.result = toolEvent.content;
            }
          }

          lastMsg.toolCalls = toolCalls;
          return newMsgs;
        });
      },
      controller.signal,
      dialogMode // 传递对话模式
    );
  };

  const insertNewlineAtCursor = (el: HTMLTextAreaElement) => {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const current = inputTextRef.current;
    const newValue = current.slice(0, start) + '\n' + current.slice(end);
    inputTextRef.current = newValue;
    setInputText(newValue);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 1;
      adjustTextareaHeight();
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;

    // Shift+Enter 始终插入换行（不发送），不受 sendKey 设置与浏览器/输入法默认行为影响
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const el = e.target as HTMLTextAreaElement;
      e.preventDefault();
      insertNewlineAtCursor(el);
      imeNewlineRef.current = true; // 阻止 handleKeyUp 触屏路径误发送
      return;
    }

    const sendKey = localStorage.getItem('sendKey') || 'enter';
    // Normalize format (settings uses underscore, old might use plus)
    const sk = sendKey.replace('+', '_').toLowerCase();

    let shouldSend = false;
    if (sk === 'enter') {
      if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) shouldSend = true;
    } else if (sk === 'ctrl_enter') {
      if (e.ctrlKey) shouldSend = true;
    } else if (sk === 'cmd_enter') {
      if (e.metaKey) shouldSend = true;
    } else if (sk === 'alt_enter') {
      if (e.altKey) shouldSend = true;
    }

    if (!shouldSend) return;

    // 桌面端：立即发送（行为不变）
    if (!(isTouchDevice && sk === 'enter')) {
      e.preventDefault();
      handleSend();
      return;
    }

    const el = e.target as HTMLTextAreaElement;

    // 触屏端：不要 preventDefault。
    // 搜狗等输入法的"换行键"在 beforeinput(insertLineBreak) 层面插入换行，
    // preventDefault 会把它拦掉，导致换行插不进去、keyup 又当成发送。
    // 这里只处理"长按"判定：长按自动重复插换行，短按交给 keyup 发送。
    if (e.repeat) {
      if (enterLongPressFiredRef.current) {
        insertNewlineAtCursor(el);
      }
      return;
    }

    // 首次按下：启动长按定时器，短按（定时器前松开）触发发送
    enterPressStartRef.current = Date.now();
    enterLongPressFiredRef.current = false;
    if (enterPressTimerRef.current) clearTimeout(enterPressTimerRef.current);
    enterPressTimerRef.current = setTimeout(() => {
      enterLongPressFiredRef.current = true;
      insertNewlineAtCursor(el);
    }, 450);
  };

  // 搜狗等输入法的"换行键"在 beforeinput(insertLineBreak) 层面插入真实换行，
  // 此时不应发送（短按也仅插入换行）。若已触发长按定时器则一并取消。
  const handleBeforeInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const ne = e.nativeEvent as InputEvent;
    if (ne && ne.inputType === 'insertLineBreak') {
      imeNewlineRef.current = true;
      if (enterPressTimerRef.current) {
        clearTimeout(enterPressTimerRef.current);
        enterPressTimerRef.current = null;
      }
      enterLongPressFiredRef.current = false;
      enterPressStartRef.current = 0;
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (!isTouchDevice) return;

    const longPressed = enterLongPressFiredRef.current;
    const newlineInserted = imeNewlineRef.current;
    enterPressStartRef.current = 0;
    enterLongPressFiredRef.current = false;
    imeNewlineRef.current = false;
    if (enterPressTimerRef.current) {
      clearTimeout(enterPressTimerRef.current);
      enterPressTimerRef.current = null;
    }
    // 输入法已真实插入换行（换行键）或判定为长按时，不发送
    if (!longPressed && !newlineInserted) {
      handleSend();
    }
  };

  // Auto-send initialMessage from Project page navigation
  useEffect(() => {
    if (pendingInitialMessageRef.current && activeId && !loading) {
      const msg = pendingInitialMessageRef.current;
      pendingInitialMessageRef.current = null;
      // Small delay to let conversation finish loading
      setTimeout(() => handleSend(msg), 150);
    }
  }, [activeId, loading]);

  // 停止生成（双模式：SSE 直连 or 轮询模式）
  const handleStop = () => {
    // 先尝试停止集群对话
    if (clusterAbortControllerRef.current) {
      console.log('[Cluster] Stopping cluster chat...');
      clusterAbortControllerRef.current.abort();
      clusterAbortControllerRef.current = null;
      setLoading(false);
      setClusterState(null);
      isCreatingRef.current = false;
      return;
    }
    
    if (abortStreamSession(activeId || undefined)) {
      if (activeId) removeStreaming(activeId);
      return;
    }
    if (pollingRef.current && activeId) {
      // 轮询模式：调用后端停止接口
      stopGeneration(activeId).catch(e => console.error('[Stop] error:', e));
      stopPolling();
    }
    if (activeId) removeStreaming(activeId);
    setLoading(false);
    isCreatingRef.current = false;
  };

  // 复制消息内容
  // 复制消息内容
  const handleCopyMessage = async (content: string, idx: number) => {
    const text = (typeof content === 'string' ? content : String(content)).trim();
    // Detect markdown image: ![alt](url)
    const imgMatch = text.match(/^!\[.*?\]\((https?:\/\/[^\s)]+)\)\s*$/);
    if (imgMatch) {
      const imageUrl = imgMatch[1];
      try {
        const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:30080' : window.location.origin;
        const resp = await fetch(`${apiBase}/api/image/proxy?url=${encodeURIComponent(imageUrl)}`);
        if (resp.ok) {
          const blob = await resp.blob();
          const mime = resp.headers.get('content-type') || 'image/png';
          const electronAPI = (window as any).electronAPI;
          if (electronAPI && typeof electronAPI.writeImageToClipboard === 'function') {
            const reader = new FileReader();
            const b64 = await new Promise<string>((resolve, reject) => {
              reader.onload = () => { const result = reader.result as string; resolve(result.split(',')[1]); };
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            await electronAPI.writeImageToClipboard(b64, mime);
          } else {
            await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
          }
          setCopiedMessageIdx(idx);
          setTimeout(() => setCopiedMessageIdx(null), 2000);
          return;
        }
      } catch (e) { console.warn('[Copy] Image clipboard failed, falling back to text:', e); }
    }
    // Default: copy as text
    copyToClipboard(text).then((success) => {
      if (success) { setCopiedMessageIdx(idx); setTimeout(() => setCopiedMessageIdx(null), 2000); }
    });
  };

  const extractMessageAttachments = (msg: any) => {
    const raw = Array.isArray(msg?.attachments)
      ? msg.attachments.filter((att: any) => att && ((typeof att.id === 'string' && att.id.trim()) || (typeof att.fileId === 'string' && att.fileId.trim())))
      : [];
    // Normalize to snake_case for component compatibility
    const attachments = raw.map((att: any) => ({
      ...att,
      id: att.id || att.fileId || '',
      file_name: att.file_name || att.fileName || 'file',
      file_type: att.file_type || att.fileType || 'document',
      mime_type: att.mime_type || att.mimeType || '',
      file_size: att.file_size || att.size || 0,
    }));
    const attachmentIds = attachments.map((att: any) => att.id);
    return {
      attachmentIds,
      attachmentsPayload: attachments.length > 0
        ? attachments.map((att: any) => ({ fileId: att.id, fileName: att.file_name, fileType: att.file_type, mimeType: att.mime_type, size: att.file_size }))
        : null,
      optimisticAttachments: attachments,
    };
  };

  // 删除单轮对话（该用户消息 + 对应 AI 回复），不影响上方与下方会话
  const handleDeleteRound = async (content: string, idx: number) => {
    if (loading) return;
    const msg = messages[idx];
    if (!msg) return;

    // 计算本轮结束位置：本条 user 消息及其后面所有 assistant 回复，直到下一条 user 消息之前
    let endIdx = idx + 1;
    while (endIdx < messages.length && messages[endIdx].role !== 'user') endIdx++;

    // 前端：仅删除该轮 [idx, endIdx)，上方与下方消息原样保留
    setMessages(prev => [
      ...prev.slice(0, idx),
      ...prev.slice(endIdx),
    ]);

    // 后端删除该轮（messageId 不可用时回退为删除尾部 N 条）
    if (activeId) {
      try {
        if (msg.id) {
          await deleteMessagesRound(activeId, msg.id);
        } else {
          const tailCount = endIdx - idx;
          if (tailCount > 0) await deleteMessagesTail(activeId, tailCount);
        }
      } catch (err) {
        console.error('Failed to delete round from backend:', err);
        alert('删除失败：' + (err instanceof Error ? err.message : String(err)));
      }
    }
  };

  // 重新发送消息
  const handleResendMessage = async (content: string, idx: number) => {
    if (loading) return;
        const msg = messages[idx];
    const { attachmentIds, attachmentsPayload, optimisticAttachments } = extractMessageAttachments(msg);
    const tempUserMsg: any = { role: 'user', content, created_at: new Date().toISOString() };
    if (optimisticAttachments.length > 0) {
      tempUserMsg.has_attachments = 1;
      tempUserMsg.attachments = optimisticAttachments;
    }
    // 删除当前消息及其后续消息（前端），然后重新添加用户消息 + assistant 占位
    setMessages(prev => [
      ...prev.slice(0, idx),
      tempUserMsg,
      { role: 'assistant', content: '' },
    ]);
    // 删除后端消息（regenerate）
    if (activeId) {
      try {
        if (msg.id) {
          await deleteMessagesFrom(activeId, msg.id, attachmentIds);
        } else {
          const tailCount = messages.length - idx;
          if (tailCount > 0) await deleteMessagesTail(activeId, tailCount, attachmentIds);
        }
      } catch (err) {
        console.error('Failed to delete messages from backend:', err);
        alert('回退失败：Git 文件回退未成功，请手动检查工作区文件状态。错误：' + (err instanceof Error ? err.message : String(err)));
      }
    }
    // 直接重新发送
    isAtBottomRef.current = true;
    setTimeout(() => scrollToBottom('auto'), 50);
    const controller = new AbortController();
    const conversationId = activeId!;
    const streamRequestId = beginStreamSession(conversationId);
    abortControllersRef.current.set(conversationId, controller);
    setLoading(true);
    addStreaming(conversationId);
    activeRequestCountRef.current += 1;
    await sendMessage(
      conversationId,
      content,
      attachmentsPayload,
      (delta, full) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = full;
            lastMsg.isThinking = false;
          }
          return newMsgs;
        });
      },
      (full) => {
        // Always clean up streaming state and request count
        removeStreaming(conversationId);
        messagesBufferRef.current.delete(conversationId);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        if (viewingIdRef.current === conversationId) setLoading(false);
        abortControllersRef.current.delete(conversationId);
        clearStreamSession(conversationId, streamRequestId);
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = full;
            lastMsg.isThinking = false;
          }
          return newMsgs;
        });
        setTimeout(() => forceSyncArtifactsRef.current?.(), 100);
        // 刷新上下文消耗显示
        getContextSize(conversationId).then(data => {
          console.log('[ContextSize] onDone 更新:', data);
          // 后台会话完成时不要覆盖当前视图的 context 显示
          if (viewingIdRef.current === conversationId) setContextInfo(data);
        }).catch(err => {
          console.error('[ContextSize] onDone 更新失败:', err);
        });
      },
      (err) => {
        // Always clean up streaming state and request count
        removeStreaming(conversationId);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setLoading(false);
        abortControllersRef.current.delete(conversationId);
        clearStreamSession(conversationId, streamRequestId);
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          if (newMsgs[newMsgs.length - 1] && newMsgs[newMsgs.length - 1].role === 'assistant') {
            newMsgs[newMsgs.length - 1].content = formatChatError(err);
            newMsgs[newMsgs.length - 1].isThinking = false;
          }
          return newMsgs;
        });
        setTimeout(() => forceSyncArtifactsRef.current?.(), 100);
      },
      (thinkingDelta, thinkingFull) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.thinking = thinkingFull;
            lastMsg.isThinking = true;
            delete lastMsg.searchStatus;
          }
          return newMsgs;
        });
      },
      (event, message, data) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        if (event === 'metadata' && data && data.user_message_id) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            const userIdx = newMsgs.length - 2;
            if (userIdx >= 0 && newMsgs[userIdx].role === 'user') {
              newMsgs[userIdx] = { ...newMsgs[userIdx], id: data.user_message_id };
            }
            return newMsgs;
          });
        }
        if (event === 'thinking_summary' && message) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.thinking_summary = message;
            }
            return newMsgs;
          });
        }
        if (event === 'context_size' && data) {
          // 后台会话的 context_size 事件不覆盖当前视图的 context 显示，也不误触发当前视图的自动压缩
          if (viewingIdRef.current !== conversationId) return;
          setContextInfo({ tokens: data.tokens, limit: data.limit });
          // SSE流式更新时也检查自动压缩
          const limit = 1000000;
          const id = activeId || conversationId;
          if (id && data && data.tokens >= limit && !autoCompactTriggered && compactStatus.state === 'idle') {
            setAutoCompactTriggered(true);
            setCompactStatus({ state: 'compacting' });
            compactConversation(id).then(async result => {
              await loadConversation(id);
              const newContextInfo = await getContextSize(id);
              setContextInfo(newContextInfo);
              setCompactStatus({ state: 'done', message: `已压缩 ${result.messagesCompacted} 条消息，节省约 ${result.tokensSaved} tokens` });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
            }).catch(err => {
              console.error('自动压缩失败:', err);
              setCompactStatus({ state: 'error', message: '自动压缩失败' });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
            });
          }
        }
        if (event === 'tool_text_offset' && data && data.offset != null) {
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.toolTextEndOffset = data.offset;
            }
            return newMsgs;
          });
        }
        if (event && event.startsWith('research_')) {
          // research 状态只反映在当前视图会话上，后台会话的 research 事件不污染当前视图
          if (viewingIdRef.current === conversationId) {
            setMessages(prev => applyResearchEvent(prev, event, data));
          }
        }
      },
      undefined,
      (doc) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentsIntoMessage(newMsgs[lastIdx], doc);
          }
          return newMsgs;
        });
      },
      (draft) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentDraftIntoMessage(newMsgs[lastIdx], draft);
          }
          return newMsgs;
        });
      },
      undefined,
      undefined,
      controller.signal
    );
  };

  // 编辑消息 — 进入原地编辑模式（不立即删除后续消息）
  const handleEditMessage = (content: string, idx: number) => {
    if (loading) return;
    setEditingMessageIdx(idx);
    setEditingContent(content);
  };

  // 取消编辑
  const handleEditCancel = () => {
    setEditingMessageIdx(null);
    setEditingContent('');
  };

  // 保存编辑 — 删除当前及后续消息，用新内容重新发送
  const handleEditSave = async () => {
    if (editingMessageIdx === null || !editingContent.trim() || loading) return;
        const idx = editingMessageIdx;
    const msg = messages[idx];
    const newContent = editingContent.trim();
    const { attachmentIds, attachmentsPayload, optimisticAttachments } = extractMessageAttachments(msg);

    // 退出编辑模式
    setEditingMessageIdx(null);
    setEditingContent('');

    const tempUserMsg: any = { role: 'user', content: newContent, created_at: new Date().toISOString() };
    if (optimisticAttachments.length > 0) {
      tempUserMsg.has_attachments = 1;
      tempUserMsg.attachments = optimisticAttachments;
    }

    // 删除当前消息及其后续消息（前端），同时加入新的用户消息和 assistant 占位
    setMessages(prev => [
      ...prev.slice(0, idx),
      tempUserMsg,
      { role: 'assistant', content: '' },
    ]);

    // 删除后端消息（regenerate）
    if (activeId) {
      try {
        if (msg.id) {
          await deleteMessagesFrom(activeId, msg.id, attachmentIds);
        } else {
          const tailCount = messages.length - idx;
          if (tailCount > 0) await deleteMessagesTail(activeId, tailCount, attachmentIds);
        }
      } catch (err) {
        console.error('Failed to delete messages from backend:', err);
        alert('编辑失败：Git 文件回退未成功，请手动检查工作区文件状态。错误：' + (err instanceof Error ? err.message : String(err)));
      }
    }

    // 直接发送新内容
    isAtBottomRef.current = true;
    setTimeout(() => scrollToBottom('auto'), 50);

    const conversationId = activeId;
    if (!conversationId) return;

    const controller = new AbortController();
    const streamRequestId = beginStreamSession(conversationId);
    abortControllersRef.current.set(conversationId, controller);
    setLoading(true);
    addStreaming(conversationId);
    activeRequestCountRef.current += 1;
    await sendMessage(
      conversationId,
      newContent,
      attachmentsPayload,
      (delta, full) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = full;
            lastMsg.isThinking = false;
          }
          return newMsgs;
        });
      },
      (full) => {
        // Always clean up streaming state and request count
        removeStreaming(conversationId);
        messagesBufferRef.current.delete(conversationId);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        if (viewingIdRef.current === conversationId) setLoading(false);
        abortControllersRef.current.delete(conversationId);
        clearStreamSession(conversationId, streamRequestId);
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = full;
            lastMsg.isThinking = false;
          }
          return newMsgs;
        });
        setTimeout(() => forceSyncArtifactsRef.current?.(), 100);
        // 刷新上下文消耗显示
        getContextSize(conversationId).then(data => {
          console.log('[ContextSize] onDone 更新:', data);
          // 后台会话完成时不要覆盖当前视图的 context 显示
          if (viewingIdRef.current === conversationId) setContextInfo(data);
        }).catch(err => {
          console.error('[ContextSize] onDone 更新失败:', err);
        });
      },
      (err) => {
        // Always clean up streaming state and request count
        removeStreaming(conversationId);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setLoading(false);
        abortControllersRef.current.delete(conversationId);
        clearStreamSession(conversationId, streamRequestId);
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          if (newMsgs[newMsgs.length - 1] && newMsgs[newMsgs.length - 1].role === 'assistant') {
            newMsgs[newMsgs.length - 1].content = formatChatError(err);
            newMsgs[newMsgs.length - 1].isThinking = false;
          }
          return newMsgs;
        });
        setTimeout(() => forceSyncArtifactsRef.current?.(), 100);
      },
      (thinkingDelta, thinkingFull) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.thinking = thinkingFull;
            lastMsg.isThinking = true;
            delete lastMsg.searchStatus;
          }
          return newMsgs;
        });
      },
      (event, message, data) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        if (event === 'metadata' && data && data.user_message_id) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            const userIdx = newMsgs.length - 2;
            if (userIdx >= 0 && newMsgs[userIdx].role === 'user') {
              newMsgs[userIdx] = { ...newMsgs[userIdx], id: data.user_message_id };
            }
            return newMsgs;
          });
        }
        if (event === 'thinking_summary' && message) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.thinking_summary = message;
            }
            return newMsgs;
          });
        }
        if (event === 'context_size' && data) {
          // 后台会话的 context_size 事件不覆盖当前视图的 context 显示，也不误触发当前视图的自动压缩
          if (viewingIdRef.current !== conversationId) return;
          setContextInfo({ tokens: data.tokens, limit: data.limit });
          // SSE流式更新时也检查自动压缩
          const limit = 1000000;
          const id = activeId || conversationId;
          if (id && data && data.tokens >= limit && !autoCompactTriggered && compactStatus.state === 'idle') {
            setAutoCompactTriggered(true);
            setCompactStatus({ state: 'compacting' });
            compactConversation(id).then(async result => {
              await loadConversation(id);
              const newContextInfo = await getContextSize(id);
              setContextInfo(newContextInfo);
              setCompactStatus({ state: 'done', message: `已压缩 ${result.messagesCompacted} 条消息，节省约 ${result.tokensSaved} tokens` });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
            }).catch(err => {
              console.error('自动压缩失败:', err);
              setCompactStatus({ state: 'error', message: '自动压缩失败' });
              setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
            });
          }
        }
        if (event === 'tool_text_offset' && data && data.offset != null) {
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.toolTextEndOffset = data.offset;
            }
            return newMsgs;
          });
        }
        if (event && event.startsWith('research_')) {
          // research 状态只反映在当前视图会话上，后台会话的 research 事件不污染当前视图
          if (viewingIdRef.current === conversationId) {
            setMessages(prev => applyResearchEvent(prev, event, data));
          }
        }
      },
      undefined,
      (doc) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentsIntoMessage(newMsgs[lastIdx], doc);
          }
          return newMsgs;
        });
      },
      (draft) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentDraftIntoMessage(newMsgs[lastIdx], draft);
          }
          return newMsgs;
        });
      },
      undefined,
      undefined,
      controller.signal
    );
  };

  // 切换消息展开/折叠
  const toggleMessageExpand = (idx: number) => {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // === 文件上传相关 ===
  const ACCEPTED_TYPES = 'image/png,image/jpeg,image/jpg,image/gif,image/webp,application/pdf,.docx,.xlsx,.pptx,.odt,.rtf,.epub,.txt,.md,.csv,.json,.xml,.yaml,.yml,.js,.jsx,.ts,.tsx,.py,.java,.cpp,.c,.h,.cs,.go,.rs,.rb,.php,.swift,.kt,.scala,.html,.css,.scss,.less,.sql,.sh,.bash,.vue,.svelte,.lua,.r,.m,.pl,.ex,.exs';

  const handleFilesSelected = (files: FileList | File[], defaults?: Partial<PendingFile>) => {
    const fileArray = Array.from(files);
    const maxFiles = 20;
    const currentCount = pendingFiles.length;
    const allowed = fileArray.slice(0, maxFiles - currentCount);

    for (const file of allowed) {
      const id = Math.random().toString(36).slice(2);
      const isImage = file.type.startsWith('image/');
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

      const pending: PendingFile = {
        id,
        file,
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
        progress: 0,
        status: 'uploading',
        previewUrl,
        ...(defaults || {}),
      };

      setPendingFiles(prev => [...prev, pending]);

      // Calculate lines for text files
      const textExtensions = /\.(txt|md|csv|json|xml|yaml|yml|js|jsx|ts|tsx|py|java|cpp|c|h|cs|go|rs|rb|php|swift|kt|scala|html|css|scss|less|sql|sh|bash|vue|svelte|lua|r|m|pl|ex|exs)$/i;
      if (file.size < 5 * 1024 * 1024 && (file.type.startsWith('text/') || textExtensions.test(file.name))) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = e.target?.result as string;
          if (text) {
            const lines = text.split(/\r\n|\r|\n/).length;
            setPendingFiles(prev => prev.map(f => f.id === id ? { ...f, lineCount: lines } : f));
          }
        };
        reader.readAsText(file);
      }

      uploadFile(file, (percent) => {
        setPendingFiles(prev => prev.map(f => f.id === id ? { ...f, progress: percent } : f));
      }, activeId).then((result) => {
        setPendingFiles(prev => prev.map(f => f.id === id ? {
          ...f,
          fileId: result.fileId,
          fileType: result.fileType,
          status: 'done' as const,
          progress: 100,
        } : f));
        // Auto-enable uploaded files (no action needed - default is enabled)
      }).catch((err) => {
        setPendingFiles(prev => prev.map(f => f.id === id ? {
          ...f,
          status: 'error' as const,
          error: err.message,
        } : f));
      });
    }
  };

  const handleRemoveFile = (id: string) => {
    setPendingFiles(prev => {
      const file = prev.find(f => f.id === id);
      if (file?.previewUrl) URL.revokeObjectURL(file.previewUrl);
      // 已上传的文件调后端删除，释放存储空间
      if (file?.fileId) {
        deleteAttachment(file.fileId).catch(() => { });
      }
      return prev.filter(f => f.id !== id);
    });
  };

  // Handle "Add from GitHub" confirmation: resolve/create conversation,
  // materialize files into its workspace, then add a visual-only card.
  const handleGithubAdd = async (payload: GithubAddPayload): Promise<void> => {
    let convId = activeId;
    let createdNewConv = false;
    if (!convId) {
      const modelForCreate = isModelSelectable(currentModelString)
        ? currentModelString
        : resolveModelForNewChat(currentModelString);
      const newConv = await createConversation(undefined, modelForCreate, { research_mode: researchMode });
      if (!newConv || !newConv.id) throw new Error('Failed to create conversation');
      convId = newConv.id;
      createdNewConv = true;
      warmEngine(convId);
      onNewChat();
    }

    const result = await materializeGithub(
      convId,
      payload.repoFullName,
      payload.ref,
      payload.selections,
    );

    const githubCard: PendingFile = {
      id: Math.random().toString(36).slice(2),
      file: new File([], 'github-placeholder'),
      fileName: payload.repoFullName,
      mimeType: 'application/x-github',
      size: 0,
      progress: 100,
      status: 'done',
      source: 'github',
      ghRepo: payload.repoFullName,
      ghRef: payload.ref,
      lineCount: result.fileCount,
    };

    if (createdNewConv) {
      // Stash the card into draftsStore under the NEW conv key so the mount
      // effect restores it. Then navigate — the useEffect will pick it up.
      const text = inputTextRef.current || '';
      const height = textareaHeightRef.current || inputBarBaseHeight;
      draftsStore.set(convId, { text, files: [githubCard], height });
      navigate(`/chat/${convId}`, { replace: true });
    } else {
      setPendingFiles(prev => [...prev, githubCard]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFilesSelected(e.dataTransfer.files);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    // 1. 优先检查图片
    const items = e.clipboardData?.items;
    if (items) {
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleFilesSelected(imageFiles);
        return;
      }
    }

    // 2. 检查长文本 (超过 10000 字符或 100 行自动转为附件)
    const text = e.clipboardData.getData('text');
    if (text) {
      const lineCount = text.split('\n').length;
      if (text.length > 10000 || lineCount > 100) {
        e.preventDefault();
        const blob = new Blob([text], { type: 'text/plain' });
        const file = new File([blob], 'Pasted-Text.txt', { type: 'text/plain' });
        handleFilesSelected([file]);
      }
    }
  };


  // --- Render Logic ---

  // Shared overlays rendered in both MODE 1 and MODE 2
  const sharedProjectOverlays = (
    <>
      {showFolderBrowser && (
        <FolderBrowser
          onSelect={async (path) => {
            try {
              const setUrl = window.location.protocol === 'file:'
                ? 'http://127.0.0.1:30080/api/workspace/set'
                : new URL('api/workspace/set', window.location.href).href;
              await fetch(setUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  workspace_path: path,
                  conversation_id: activeIdRef.current || undefined
                })
              });
              setShowFolderBrowser(false);
            } catch (err) {
              console.error('[Workspace] Set workspace failed:', err);
              alert('更改工作区失败: ' + err.message);
            }
          }}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}
      {showNewProjectDialog && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
          onClick={() => { setShowNewProjectDialog(false); setNewProjectName(''); setNewProjectDescription(''); }}
        >
          <div className="bg-simona-bg border border-simona-border rounded-2xl shadow-xl w-[560px] max-w-[92vw] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between px-7 pt-6 pb-4">
              <h2 className="font-[Spectral] text-[22px] text-simona-text" style={{ fontWeight: 600 }}>创建项目</h2>
              <button
                onClick={() => { setShowNewProjectDialog(false); setNewProjectName(''); setNewProjectDescription(''); }}
                className="p-1 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-7 pb-4 space-y-5">
              <div>
                <label className="block text-[15px] font-medium text-simona-textSecondary mb-2">你在做什么？</label>
                <input
                  type="text"
                  placeholder="输入项目名称"
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && newProjectName.trim()) handleCreateProjectFromMenu(); }}
                  className="w-full px-4 py-3 bg-white dark:bg-simona-input border border-gray-200 dark:border-simona-border rounded-xl text-simona-text placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-[#387ee0] focus:ring-0 transition-all text-[15px]"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-[15px] font-medium text-simona-textSecondary mb-2">你的目标是什么？</label>
                <textarea
                  placeholder="描述你的项目、目标、主题等..."
                  rows={3}
                  value={newProjectDescription}
                  onChange={e => setNewProjectDescription(e.target.value)}
                  className="w-full px-4 py-3 bg-white dark:bg-simona-input border border-gray-200 dark:border-simona-border rounded-xl text-simona-text placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-[#387ee0] focus:ring-0 transition-all text-[15px] resize-none"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-7 pb-6 pt-2">
              <button
                onClick={() => { setShowNewProjectDialog(false); setNewProjectName(''); setNewProjectDescription(''); }}
                className="px-5 py-2.5 text-[15px] font-medium text-simona-text bg-white dark:bg-simona-bg border border-gray-300 dark:border-simona-border hover:bg-gray-50 dark:hover:bg-simona-hover rounded-xl transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreateProjectFromMenu}
                disabled={!newProjectName.trim()}
                className="px-5 py-2.5 text-[15px] font-medium text-simona-bg bg-black dark:bg-white dark:text-black hover:opacity-90 rounded-xl transition-opacity disabled:opacity-40"
              >
                创建项目
              </button>
            </div>
          </div>
        </div>
      )}
      {projectAddToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] px-4 py-2 bg-simona-input border border-simona-border rounded-lg shadow-lg text-[13px] text-simona-text flex items-center gap-2">
          <Check size={14} className="text-[#C6613F]" />
          {projectAddToast}
        </div>
      )}
      {webSearchToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] px-4 py-2 bg-simona-input border border-simona-border rounded-lg shadow-lg text-[13px] text-simona-text flex items-center gap-2">
          <IconWebSearch size={14} className="text-simona-textSecondary" />
          {webSearchToast}
        </div>
      )}
    </>
  );

  // MODE 1: Landing Page (No ID)
  if (!activeId && messages.length === 0) {
    return (
      <div className={`flex-1 bg-simona-bg h-screen flex flex-col relative overflow-hidden text-simona-text chat-font-scope ${showEntranceAnimation ? 'animate-slide-in' : ''}`}>

        {/* Centered Content */}
        <div
          className="flex-1 flex flex-col items-center w-full mx-auto px-4"
          style={{
            maxWidth: `${tunerConfig?.mainContentWidth || 768}px`,
            marginTop: `${tunerConfig?.mainContentMt || 0}px`,
            paddingTop: '40vh'
          }}
        >

          <div
            className="flex items-center gap-4"
            style={{ marginBottom: `${tunerConfig?.welcomeMb || 40}px` }}
          >
            <div className="w-[120px] h-[120px] shrink-0 flex items-center justify-center -mx-[16px]" style={{ marginTop: '-16px', marginBottom: '-16px' }}>
              <SimonaLogo color="#5B9BFF" maxScale={0.7} />
            </div>
            <h1
              className="text-simona-text dark:!text-[#d6cec3] tracking-tight leading-none pt-1 transition-all duration-100 ease-out whitespace-nowrap hidden md:block"
              style={{
                fontFamily: 'Optima, Candara, "Segoe UI", Segoe, "Humanist 521", sans-serif',
                fontSize: '46px',
                fontWeight: 500,
                letterSpacing: '-0.05em',
              }}
            >
              {welcomeGreeting}
            </h1>
            <button
              onClick={async () => {
                if ((window as any).electronAPI?.openFolder) {
                  try {
                    const wsUrl = activeId 
                      ? `http://127.0.0.1:30080/api/workspace/current?conversation_id=${activeId}`
                      : 'http://127.0.0.1:30080/api/workspace/current';
                    const wsRes = await fetch(wsUrl);
                    if (!wsRes.ok) return;
                    const wsData = await wsRes.json();
                    if (wsData.workspace_path) {
                      (window as any).electronAPI.openFolder(wsData.workspace_path);
                    }
                  } catch (e) { 
                    console.error('[Workspace] Open folder failed:', e); 
                  }
                } else {
                  setShowFolderBrowser(true);
                }
              }}
              onContextMenu={async (e) => {
                e.preventDefault();
                if ((window as any).electronAPI?.selectDirectory) {
                  try {
                    const result = await (window as any).electronAPI.selectDirectory();
                    if (!result) return;
                    const res = await fetch('http://127.0.0.1:30080/api/workspace/set', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ workspace_path: result, conversation_id: activeId || undefined })
                    });
                    if (!res.ok) throw new Error('Failed to set workspace');
                  } catch (err) {
                    console.error('[Workspace] Select workspace failed:', err);
                    alert('更改工作区失败: ' + err.message);
                  }
                } else {
                  setShowFolderBrowser(true);
                }
              }}
              className="p-2 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded-lg transition-colors"
              title="打开工作区文件夹（右键选择目录）"
            >
              <Folder size={24} strokeWidth={1.5} />
            </button>
          </div>

          {/* 输入框区域 */}
          <div className="w-full relative group">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              multiple
              accept={ACCEPTED_TYPES}
              onChange={(e) => {
                if (e.target.files) handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
            />
            <div
              className={`bg-simona-input border shadow-[0_2px_8px_rgba(0,0,0,0.02)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)] hover:border-[#CCC] dark:hover:border-[#5a5a58] focus-within:shadow-[0_2px_8px_rgba(0,0,0,0.08)] focus-within:border-[#CCC] dark:focus-within:border-[#5a5a58] transition-all duration-200 flex flex-col max-h-[60vh] font-sans ${isDragging ? 'border-[#D97757] bg-orange-50/30' : 'border-simona-border dark:border-[#3a3a38]'}`}
              style={{ borderRadius: `${tunerConfig?.inputRadius || 16}px` }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="flex-1 overflow-y-auto min-h-0">
                <FileUploadPreview files={pendingFiles} onRemove={handleRemoveFile} />
                <div className="relative">
                  <SkillInputOverlay
                    text={inputText}
                    className="pl-5 pr-4 pt-5 pb-1 text-[16px] font-sans font-[350] overflow-hidden"
                    style={{ minHeight: '48px' }}
                  />
                  <textarea
                    ref={inputRef}
                    className={`w-full pl-5 pr-4 pt-5 pb-1 placeholder:text-simona-textSecondary text-[16px] outline-none resize-none overflow-hidden bg-transparent font-sans font-[350] ${inputText.match(/^\/[a-zA-Z0-9_-]+/) ? 'text-transparent caret-simona-text' : 'text-simona-text'}`}
                    style={{ minHeight: '48px', borderRadius: `${tunerConfig?.inputRadius || 16}px ${tunerConfig?.inputRadius || 16}px 0 0` }}
                    placeholder={selectedSkill ? `描述您希望 ${selectedSkill.name} 做什么...` : "今天有什么可以帮您的？"}
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = Math.min(e.target.scrollHeight, 300) + 'px';
                      e.target.style.overflowY = e.target.scrollHeight > 300 ? 'auto' : 'hidden';
                    }}
                    onKeyDown={(e) => {
                      // Backspace deletes entire /skill-name as a unit
                      if (e.key === 'Backspace' && selectedSkill) {
                        const pos = (e.target as HTMLTextAreaElement).selectionStart;
                        const skillPrefix = `/${selectedSkill.slug} `;
                        if (pos > 0 && pos <= skillPrefix.length && inputText.startsWith(skillPrefix.slice(0, pos))) {
                          e.preventDefault();
                          setInputText(inputText.slice(skillPrefix.length));
                          setSelectedSkill(null);
                          return;
                        }
                      }
                      handleKeyDown(e);
                    }}
                    onKeyUp={handleKeyUp}
                    onBeforeInput={handleBeforeInput}
                    onPaste={handlePaste}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const selection = window.getSelection()?.toString();
                      const selectedText = selection || '';
                      const menuItems: Array<{ label: string; separator?: boolean; disabled?: boolean; onClick: () => void }> = [];
                      menuItems.push({ label: '复制', disabled: !selectedText, onClick: () => { if (selectedText) navigator.clipboard.writeText(selectedText); } });
                      menuItems.push({ label: '剪切', disabled: !selectedText, onClick: () => { if (selectedText) { navigator.clipboard.writeText(selectedText); const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }); inputRef.current?.dispatchEvent(event); } } });
                      menuItems.push({ label: '粘贴', onClick: async () => { try { const text = await navigator.clipboard.readText(); const textarea = inputRef.current; if (textarea) { const start = textarea.selectionStart; const end = textarea.selectionEnd; const newValue = inputText.substring(0, start) + text + inputText.substring(end); setInputText(newValue); setTimeout(() => { textarea.selectionStart = textarea.selectionEnd = start + text.length; textarea.focus(); }, 0); } } catch (err) { console.error('[ContextMenu] Paste failed:', err); } } });
                      menuItems.push({ label: '全选', onClick: () => { inputRef.current?.select(); } });
                      if (selectedText && selectedText.trim()) {
                        menuItems.push({ separator: true, onClick: () => {} });
                        menuItems.push({ label: `用 Google 搜索 "${selectedText.trim().length > 30 ? selectedText.trim().substring(0, 30) + '...' : selectedText.trim()}"`, onClick: () => { window.open(`https://www.google.com/search?q=${encodeURIComponent(selectedText.trim())}`, '_blank'); } });
                      }
                      showContextMenu(e.clientX, e.clientY, menuItems, () => {});
                    }}
                  />
                </div>
              </div>
              <div className="px-4 pb-3 pt-1 flex items-center justify-between flex-shrink-0">
                <div className="relative flex items-center gap-1">
                  <button
                    ref={plusBtnRef}
                    onClick={() => setShowPlusMenu(prev => !prev)}
                    className="p-2 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded-lg transition-colors"
                  >
                    <IconPlus size={20} />
                  </button>
                  
                                    {showPlusMenu && (
                    <div
                      ref={plusMenuRef}
                      className="absolute bottom-full left-0 mb-2 w-[220px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1.5 z-50"
                    >
                      <button
                        onMouseEnter={() => { setShowSkillsSubmenu(false); setShowProjectsSubmenu(false); }}
                        onClick={() => { setShowPlusMenu(false); fileInputRef.current?.click(); }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-simona-text hover:bg-simona-hover transition-colors"
                      >
                        <Paperclip size={16} className="text-simona-textSecondary" />
                        添加文件或图片
                      </button>
                      <div className="relative" onMouseLeave={() => setShowProjectsSubmenu(false)}>
                        <button
                          onMouseEnter={() => { setShowProjectsSubmenu(true); setShowSkillsSubmenu(false); }}
                          onClick={() => setShowProjectsSubmenu(prev => !prev)}
                          className="w-full flex items-center justify-between px-4 py-2.5 text-[13px] text-simona-text hover:bg-simona-hover transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            <IconProjects size={16} className="text-simona-textSecondary scale-[1.6] dark:[filter:brightness(0)_invert(1)_brightness(0.68)_sepia(0.18)]" />
                            添加到项目
                          </div>
                          <ChevronDown size={14} className="text-simona-textSecondary -rotate-90" />
                        </button>
                        {showProjectsSubmenu && (
                          <div className="absolute left-full bottom-0 w-[220px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1.5 z-50 max-h-[30vh] overflow-y-auto">
                            {projectList.length > 0 ? projectList.map(p => {
                              const isSelected = (activeId && currentProjectId === p.id) || (!activeId && pendingProjectId === p.id);
                              return (
                                <button
                                  key={p.id}
                                  onClick={() => handleAttachToProject(p)}
                                  className="w-full flex items-center justify-between gap-2 px-4 py-2 text-[13px] text-simona-text hover:bg-simona-hover transition-colors text-left"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <IconProjects size={26} className="text-simona-textSecondary flex-shrink-0 dark:[filter:brightness(0)_invert(1)_brightness(0.68)_sepia(0.18)]" />
                                    <span className="truncate">{p.name}</span>
                                  </div>
                                  {isSelected && <Check size={14} className="text-simona-textSecondary flex-shrink-0" />}
                                </button>
                              );
                            }) : (
                              <div className="px-4 py-2 text-[12px] text-simona-textSecondary italic">暂无项目</div>
                            )}
                            <div className="border-t border-simona-border mt-1 pt-1">
                              <button
                                onClick={() => {
                                  setShowProjectsSubmenu(false);
                                  setShowPlusMenu(false);
                                  setNewProjectName('');
                                  setNewProjectDescription('');
                                  setShowNewProjectDialog(true);
                                }}
                                className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-simona-textSecondary hover:bg-simona-hover transition-colors"
                              >
                                <Plus size={14} />
                                新建项目
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="relative" onMouseLeave={() => setShowSkillsSubmenu(false)}>
                        <button
                          onMouseEnter={() => { setShowSkillsSubmenu(true); setShowProjectsSubmenu(false); }}
                          onClick={() => setShowSkillsSubmenu(prev => !prev)}
                          className="w-full flex items-center justify-between px-4 py-2.5 text-[13px] text-simona-text hover:bg-simona-hover transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            <FileText size={16} className="text-simona-textSecondary" />
                            技能
                          </div>
                          <ChevronDown size={14} className="text-simona-textSecondary -rotate-90" />
                        </button>
                        {showSkillsSubmenu && (
                          <div className="absolute left-full bottom-0 w-[220px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1.5 z-50 max-h-[30vh] overflow-y-auto">
                            {enabledSkills.length > 0 ? enabledSkills.map(skill => (
                              <button
                                key={skill.id}
                                onClick={() => {
                                  setShowPlusMenu(false); setShowSkillsSubmenu(false);
                                  const slug = skill.name.toLowerCase().replace(/\s+/g, '-');
                                  setSelectedSkill({ name: skill.name, slug, description: skill.description });
                                  setInputText(prev => prev ? `/${slug} ${prev}` : `/${slug} `);
                                  inputRef.current?.focus();
                                }}
                                className="w-full text-left px-4 py-2 text-[13px] text-simona-text hover:bg-simona-hover transition-colors truncate"
                              >
                                {skill.name}
                              </button>
                            )) : (
                              <div className="px-4 py-2 text-[12px] text-simona-textSecondary italic">暂无可用技能</div>
                            )}
                            <div className="border-t border-simona-border mt-1 pt-1">
                              <button
                                onClick={() => { setShowPlusMenu(false); window.location.hash = '#/customize'; }}
                                className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-simona-textSecondary hover:bg-simona-hover transition-colors"
                              >
                                <FileText size={14} />
                                管理技能
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {/* Blue research badge next to + button when enabled */}
                  {researchMode && (
                    <div className="group/research relative ml-1 flex items-center bg-[#DBEAFE] dark:bg-[#1E3A5F] rounded-lg p-1.5">
                      <IconResearch size={16} className="text-[#2E7CF6] flex-shrink-0" />
                      <span className="inline-flex items-center overflow-hidden w-0 group-hover/research:w-[18px] transition-[width] duration-150 ease-out">
                        <button
                          onClick={toggleResearchMode}
                          className="ml-1 flex-shrink-0 flex items-center justify-center hover:opacity-70 transition-opacity"
                          aria-label="Disable research mode"
                        >
                          <X size={14} className="text-[#2E7CF6]" />
                        </button>
                      </span>
                      <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 bg-[#2a2a2a] text-white dark:bg-[#e8e8e8] dark:text-[#1a1a1a] rounded-md text-[11px] whitespace-nowrap opacity-0 group-hover/research:opacity-100 pointer-events-none transition-opacity">
                        Research mode
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <ModelSelector
                    currentModelString={currentModelString}
                    models={selectorModels}
                    onModelChange={handleModelChange}
                    isNewChat={true}
                    clusterEnabled={clusterEnabled}
                    onClusterToggle={setClusterEnabled}
                    clusterAgentCount={clusterConfig.agentCount}
                    onClusterAgentCountChange={(count) => setClusterConfig({ ...clusterConfig, agentCount: count })}
                    showSwarmButton={showSwarmButton}
                  />
                  {/* 人设切换按钮 */}
                  {personas.length > 0 && (
                    <div className="relative" ref={personaDropdownRef}>
                      <button
                        onClick={() => setShowPersonaDropdown(!showPersonaDropdown)}
                        className={`px-2.5 py-1.5 text-[12px] font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                          currentPersonaId
                            ? 'bg-[#5B9BFF]/10 border border-[#5B9BFF]/30 text-[#5B9BFF]'
                            : 'bg-simona-input border border-simona-border text-simona-textSecondary hover:text-simona-text hover:border-simona-textSecondary'
                        }`}
                        title={currentPersonaId ? `当前人设: ${personas.find(p => p.id === currentPersonaId)?.name || '未命名'}` : '切换人设'}
                      >
                        <User size={14} />
                        {currentPersonaId ? personas.find(p => p.id === currentPersonaId)?.name : '人设'}
                      </button>
                      
                      {/* 人设下拉菜单 */}
                      {showPersonaDropdown && (
                        <div className="absolute bottom-full right-0 mb-2 w-[240px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-2 z-50">
                          <div className="px-3 py-2 border-b border-simona-border">
                            <div className="text-[12px] font-medium text-simona-textSecondary">选择人设</div>
                          </div>
                          <div className="max-h-[300px] overflow-y-auto">
                            {/* 无人设选项 */}
                            <button
                              onClick={() => handleSwitchPersona('')}
                              className={`w-full px-3 py-2.5 text-left hover:bg-simona-hover transition-colors ${
                                !currentPersonaId ? 'bg-[#5B9BFF]/5' : ''
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <div className="w-7 h-7 rounded-full bg-simona-textSecondary/20 flex items-center justify-center flex-shrink-0">
                                  <User size={14} className="text-simona-textSecondary" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[13px] font-medium text-simona-text">无人设</div>
                                  <div className="text-[11px] text-simona-textSecondary">使用默认设置</div>
                                </div>
                                {!currentPersonaId && <Check size={14} className="text-[#5B9BFF]" />}
                              </div>
                            </button>
                            
                            {/* 人设列表 */}
                            {personas.map(persona => (
                              <button
                                key={persona.id}
                                onClick={() => handleSwitchPersona(persona.id)}
                                className={`w-full px-3 py-2.5 text-left hover:bg-simona-hover transition-colors ${
                                  currentPersonaId === persona.id ? 'bg-[#5B9BFF]/5' : ''
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-medium flex-shrink-0 ${
                                    currentPersonaId === persona.id ? 'bg-[#5B9BFF]' : 'bg-simona-textSecondary'
                                  }`}>
                                    {persona.name.charAt(0).toUpperCase()}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[13px] font-medium text-simona-text truncate">{persona.name}</div>
                                    {persona.description && (
                                      <div className="text-[11px] text-simona-textSecondary truncate">{persona.description}</div>
                                    )}
                                  </div>
                                  {currentPersonaId === persona.id && <Check size={14} className="text-[#5B9BFF]" />}
                                </div>
                              </button>
                            ))}
                          </div>
                          <div className="px-3 py-2 border-t border-simona-border mt-1">
                            <button
                              onClick={() => {
                                setShowPersonaDropdown(false);
                                window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'general' } }));
                              }}
                              className="w-full text-[12px] text-[#5B9BFF] hover:text-[#4A8AE6] transition-colors"
                            >
                              + 管理人设
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSend()}
                    disabled={(!inputText.trim() && !pendingFiles.some(f => f.status === 'done')) || loading || pendingFiles.some(f => f.status === 'uploading')}
                    className={`p-2 rounded-lg transition-colors disabled:cursor-not-allowed ${
                      (!inputText.trim() && !pendingFiles.some(f => f.status === 'done')) || pendingFiles.some(f => f.status === 'uploading')
                        ? 'bg-simona-input text-simona-textSecondary/40'
                        : 'bg-simona-hover text-simona-text hover:bg-simona-btn-hover'
                    }`}
                  >
                    <ArrowUp size={22} strokeWidth={2.5} />
                  </button>
                </div>
              </div>
            </div>
            {false && (
              <div className="mx-4 flex items-center justify-between px-4 py-1.5 bg-simona-bgSecondary border-x border-b border-simona-border rounded-b-xl text-simona-textSecondary text-xs">
                <span>您当前没有可用套餐，无法发送消息</span>
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('open-upgrade'))}
                  className="px-2 py-0.5 bg-simona-btnHover hover:bg-simona-hover text-simona-text text-xs font-medium rounded transition-colors border border-simona-border hover:border-blue-500 hover:text-blue-600"
                >
                  购买套餐
                </button>
              </div>
            )}
          </div>

          {/* 技能市场按钮 - 固定在输入框下方 */}
          <div className="w-full flex justify-center gap-3 mt-3">
            {/* 抖音运营技能市场 (已隐藏) */}
            <button style={{ display: 'none' }}
              onClick={() => setSkillMarketCategory('douyin')}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg shadow-sm transition-all duration-200 bg-simona-input border-simona-border text-simona-textSecondary hover:text-simona-text hover:shadow-md hover:border-[#CCC] dark:hover:border-[#5a5a58] active:scale-110"
              title="抖音运营技能市场"
            >
              <svg viewBox="0 0 1024 1024" className="w-5 h-5 opacity-70 group-hover:opacity-100 transition-opacity" fill="currentColor">
                <path d="M511.506963 239.388444c1.441185-78.506667 0-157.013333 1.441185-235.52h159.93363c-1.441185 13.084444 1.441185 27.610074 4.361481 40.694519h-117.76v638.255407a130.844444 130.844444 0 0 1-20.366222 77.027556 135.774815 135.774815 0 0 1-101.755259 65.422222A130.085926 130.085926 0 0 1 360.296296 809.339259c-17.445926-10.202074-33.412741-23.286519-45.056-40.732444 40.694519 21.807407 94.511407 21.807407 133.764741-4.361482 39.253333-23.248593 63.943111-68.304593 63.943111-114.839703-1.441185-136.647111-1.441185-273.332148-1.441185-409.97926z m264.609185-45.056c21.807407 13.084444 47.976296 24.689778 72.666074 30.530371 14.563556 4.361481 30.53037 4.361481 46.535111 4.361481v36.333037c-45.056-10.164148-87.22963-36.333037-119.201185-71.224889z"></path>
                <path d="M222.208 394.960593A287.857778 287.857778 0 0 1 416.995556 354.228148v39.253333c-61.060741 0-122.121481 21.807407-171.538963 58.178371-39.253333 29.051259-66.863407 66.863407-87.22963 110.478222-20.366222 40.694519-29.089185 85.788444-29.089185 132.28563a290.133333 290.133333 0 0 0 37.812148 142.487703c11.643259 20.366222 23.248593 40.694519 40.694518 55.258074-33.412741-23.286519-62.501926-55.258074-84.309333-91.591111C94.245926 752.602074 81.161481 697.344 82.678519 640.644741 85.522963 589.748148 98.607407 537.41037 126.255407 493.795556a284.330667 284.330667 0 0 1 95.952593-98.834963z"></path>
                <path d="M559.483259 44.562963h119.201185c4.361481 21.807407 13.084444 45.093926 21.807408 65.422222a195.204741 195.204741 0 0 0 71.262815 78.506667c2.88237 1.479111 4.361481 2.920296 4.361481 4.361481 31.971556 34.891852 74.145185 61.060741 120.642371 71.262815 1.479111 40.694519 0 84.309333 0 126.482963a366.516148 366.516148 0 0 1-220.956445-69.783704c0 100.314074 0 200.628148 1.441185 299.463112 0 13.084444 1.441185 26.168889 0 40.732444a334.430815 334.430815 0 0 1-43.614815 138.088296c-21.807407 36.370963-49.417481 69.783704-84.309333 94.511408a271.966815 271.966815 0 0 1-152.651852 52.337777 319.905185 319.905185 0 0 1-82.868148-7.281777c-39.253333-8.722963-74.145185-23.248593-106.154667-46.497186l-2.88237-2.920296a217.315556 217.315556 0 0 1-40.732444-55.258074c-23.248593-42.135704-37.774222-93.032296-37.774223-142.449778a279.248593 279.248593 0 0 1 29.05126-132.323555c20.366222-42.135704 49.455407-82.868148 87.229629-110.478222C292.02963 410.927407 353.09037 390.637037 415.55437 389.12c1.441185 16.004741 0 32.009481 1.441186 47.976296v81.426963c-20.328296-7.281778-42.135704-7.281778-63.943112-2.920296-24.727704 4.361481-49.455407 16.004741-66.901333 33.450667a118.935704 118.935704 0 0 0-29.051259 36.333037c-13.084444 23.286519-16.004741 50.896593-13.084445 77.065481 2.88237 26.168889 13.084444 50.896593 30.530371 69.783704 11.605333 13.084444 26.168889 23.248593 40.694518 33.450667 11.643259 15.966815 27.610074 30.53037 45.056 40.694518 23.286519 13.084444 50.896593 17.445926 77.065482 16.004741 40.694519-2.920296 79.947852-29.089185 101.755259-65.422222a160.57837 160.57837 0 0 0 20.366222-77.065482V44.562963z"></path>
              </svg>
              <span className="text-[13px] font-medium">抖音运营</span>
            </button>

            {/* TikTok运营技能市场 (已隐藏) */}
            <button style={{ display: 'none' }}
              onClick={() => setSkillMarketCategory('tiktok')}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg shadow-sm transition-all duration-200 bg-simona-input border-simona-border text-simona-textSecondary hover:text-simona-text hover:shadow-md hover:border-[#CCC] dark:hover:border-[#5a5a58] active:scale-110"
              title="TikTok运营技能市场"
            >
              <svg viewBox="0 0 1024 1024" className="w-5 h-5 opacity-70 group-hover:opacity-100 transition-opacity" fill="currentColor">
                <path d="M511.506963 239.388444c1.441185-78.506667 0-157.013333 1.441185-235.52h159.93363c-1.441185 13.084444 1.441185 27.610074 4.361481 40.694519h-117.76v638.255407a130.844444 130.844444 0 0 1-20.366222 77.027556 135.774815 135.774815 0 0 1-101.755259 65.422222A130.085926 130.085926 0 0 1 360.296296 809.339259c-17.445926-10.202074-33.412741-23.286519-45.056-40.732444 40.694519 21.807407 94.511407 21.807407 133.764741-4.361482 39.253333-23.248593 63.943111-68.304593 63.943111-114.839703-1.441185-136.647111-1.441185-273.332148-1.441185-409.97926z m264.609185-45.056c21.807407 13.084444 47.976296 24.689778 72.666074 30.530371 14.563556 4.361481 30.53037 4.361481 46.535111 4.361481v36.333037c-45.056-10.164148-87.22963-36.333037-119.201185-71.224889z"></path>
                <path d="M222.208 394.960593A287.857778 287.857778 0 0 1 416.995556 354.228148v39.253333c-61.060741 0-122.121481 21.807407-171.538963 58.178371-39.253333 29.051259-66.863407 66.863407-87.22963 110.478222-20.366222 40.694519-29.089185 85.788444-29.089185 132.28563a290.133333 290.133333 0 0 0 37.812148 142.487703c11.643259 20.366222 23.248593 40.694519 40.694518 55.258074-33.412741-23.286519-62.501926-55.258074-84.309333-91.591111C94.245926 752.602074 81.161481 697.344 82.678519 640.644741 85.522963 589.748148 98.607407 537.41037 126.255407 493.795556a284.330667 284.330667 0 0 1 95.952593-98.834963z"></path>
                <path d="M559.483259 44.562963h119.201185c4.361481 21.807407 13.084444 45.093926 21.807408 65.422222a195.204741 195.204741 0 0 0 71.262815 78.506667c2.88237 1.479111 4.361481 2.920296 4.361481 4.361481 31.971556 34.891852 74.145185 61.060741 120.642371 71.262815 1.479111 40.694519 0 84.309333 0 126.482963a366.516148 366.516148 0 0 1-220.956445-69.783704c0 100.314074 0 200.628148 1.441185 299.463112 0 13.084444 1.441185 26.168889 0 40.732444a334.430815 334.430815 0 0 1-43.614815 138.088296c-21.807407 36.370963-49.417481 69.783704-84.309333 94.511408a271.966815 271.966815 0 0 1-152.651852 52.337777 319.905185 319.905185 0 0 1-82.868148-7.281777c-39.253333-8.722963-74.145185-23.248593-106.154667-46.497186l-2.88237-2.920296a217.315556 217.315556 0 0 1-40.732444-55.258074c-23.248593-42.135704-37.774222-93.032296-37.774223-142.449778a279.248593 279.248593 0 0 1 29.05126-132.323555c20.366222-42.135704 49.455407-82.868148 87.229629-110.478222C292.02963 410.927407 353.09037 390.637037 415.55437 389.12c1.441185 16.004741 0 32.009481 1.441186 47.976296v81.426963c-20.328296-7.281778-42.135704-7.281778-63.943112-2.920296-24.727704 4.361481-49.455407 16.004741-66.901333 33.450667a118.935704 118.935704 0 0 0-29.051259 36.333037c-13.084444 23.286519-16.004741 50.896593-13.084445 77.065481 2.88237 26.168889 13.084444 50.896593 30.530371 69.783704 11.605333 13.084444 26.168889 23.248593 40.694518 33.450667 11.643259 15.966815 27.610074 30.53037 45.056 40.694518 23.286519 13.084444 50.896593 17.445926 77.065482 16.004741 40.694519-2.920296 79.947852-29.089185 101.755259-65.422222a160.57837 160.57837 0 0 0 20.366222-77.065482V44.562963z"></path>
              </svg>
              <span className="text-[13px] font-medium">TikTok运营</span>
            </button>

            {/* 图片生成技能市场 (已隐藏) */}
            <button style={{ display: 'none' }}
              onClick={() => setSkillMarketCategory('image')}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg shadow-sm transition-all duration-200 bg-simona-input border-simona-border text-simona-textSecondary hover:text-simona-text hover:shadow-md hover:border-[#CCC] dark:hover:border-[#5a5a58] active:scale-110"
              title="图片生成技能市场"
            >
              <svg viewBox="0 0 1024 1024" className="w-5 h-5 opacity-70 group-hover:opacity-100 transition-opacity" fill="currentColor">
                <path d="M908.8 960H115.2C51.2 960 0 908.8 0 844.8V179.2C0 115.2 51.2 64 115.2 64h793.6c64 0 115.2 51.2 115.2 115.2v665.6c0 64-51.2 115.2-115.2 115.2zM115.2 128c-32 0-51.2 25.6-51.2 51.2v665.6c0 25.6 25.6 51.2 51.2 51.2h793.6c25.6 0 51.2-25.6 51.2-51.2V179.2c0-25.6-25.6-51.2-51.2-51.2H115.2z"></path>
                <path d="M384 512c-70.4 0-128-57.6-128-128s57.6-128 128-128 128 57.6 128 128-57.6 128-128 128z m0-192c-38.4 0-64 25.6-64 64s25.6 64 64 64 64-25.6 64-64-25.6-64-64-64z"></path>
                <path d="M832 768H192c-19.2 0-32-12.8-32-32 0-6.4 0-12.8 6.4-19.2l128-192c12.8-19.2 38.4-25.6 57.6-12.8 6.4 6.4 12.8 12.8 19.2 19.2l83.2 108.8 140.8-179.2c12.8-19.2 38.4-19.2 57.6-6.4l211.2 243.2c12.8 12.8 12.8 32 6.4 44.8-6.4 12.8-19.2 25.6-38.4 25.6z m-537.6-64h460.8L592 500.8 476.8 648c-6.4 6.4-12.8 12.8-19.2 12.8s-19.2-6.4-25.6-12.8l-89.6-115.2L294.4 704z"></path>
              </svg>
              <span className="text-[13px] font-medium">图片生成</span>
            </button>

            {/* 视频生成技能市场 (已隐藏) */}
            <button style={{ display: 'none' }}
              onClick={() => setSkillMarketCategory('video')}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg shadow-sm transition-all duration-200 bg-simona-input border-simona-border text-simona-textSecondary hover:text-simona-text hover:shadow-md hover:border-[#CCC] dark:hover:border-[#5a5a58] active:scale-110"
              title="视频生成技能市场"
            >
              <svg viewBox="0 0 1024 1024" className="w-5 h-5 opacity-70 group-hover:opacity-100 transition-opacity" fill="currentColor">
                <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z m0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"></path>
                <path d="M464.4 621.9l162.4-97.4c12.4-7.4 12.4-25.1 0-32.5L464.4 394.7c-12.4-7.4-28.4 1.9-28.4 16.3v194.6c0 14.4 16 23.7 28.4 16.3z"></path>
              </svg>
              <span className="text-[13px] font-medium">视频生成</span>
            </button>
          </div>

          {/* 微信连接按钮 - 功能性组件 (已隐藏) */}
          {/* <div className="w-full flex justify-center mt-4">
            <button
              onClick={() => {
                if (wechatConnected) {
                  handleWechatDisconnect();
                } else {
                  handleWechatConnect();
                }
              }}
              disabled={wechatConnecting}
              className={`flex items-center gap-2 px-4 py-2 border rounded-lg shadow-sm transition-all duration-200 group ${
                wechatConnecting
                  ? 'bg-gray-400 border-gray-400 text-white cursor-not-allowed'
                  : wechatConnected
                    ? 'bg-[#4CBF00] border-[#4CBF00] text-white hover:shadow-md hover:bg-[#43A800]'
                    : 'bg-simona-input border-simona-border text-simona-textSecondary hover:text-simona-text hover:shadow-md hover:border-[#CCC] dark:hover:border-[#5a5a58]'
              }`}
              title={wechatConnected ? '点击断开微信连接' : '点击连接微信'}
              style={{ transition: 'all 0.2s ease, transform 0.15s ease' }}
            >
              <svg viewBox="0 0 1024 1024" className="w-5 h-5 opacity-70 group-hover:opacity-100 transition-opacity" fill="currentColor">
                <path d="M1024 619.52c0-143.36-138.24-256-307.2-256s-307.2 112.64-307.2 256 138.24 256 307.2 256c30.72 0 61.44-5.12 92.16-10.24l97.28 51.2-25.6-76.8c87.04-51.2 143.36-128 143.36-220.16z m-414.72-40.96c-30.72 0-51.2-20.48-51.2-51.2s20.48-51.2 51.2-51.2 51.2 20.48 51.2 51.2c0 25.6-25.6 51.2-51.2 51.2z m209.92 0c-30.72 0-51.2-20.48-51.2-51.2s20.48-51.2 51.2-51.2 51.2 20.48 51.2 51.2c0 25.6-25.6 51.2-51.2 51.2z"></path>
                <path d="M358.4 609.28c0-158.72 153.6-286.72 348.16-286.72h15.36c-40.96-133.12-179.2-235.52-353.28-235.52-204.8 0-368.64 138.24-368.64 307.2 0 107.52 66.56 204.8 168.96 256l-30.72 92.16L256 686.08c35.84 10.24 71.68 15.36 112.64 15.36h10.24c-15.36-30.72-20.48-61.44-20.48-92.16z m138.24-414.72c35.84 0 66.56 30.72 66.56 66.56s-30.72 66.56-66.56 66.56C460.8 322.56 430.08 291.84 430.08 256S460.8 194.56 496.64 194.56zM245.76 322.56c-35.84 0-61.44-30.72-61.44-66.56s30.72-66.56 66.56-66.56 61.44 30.72 61.44 66.56-30.72 66.56-66.56 66.56z"></path>
              </svg>
              <span className="text-[13px] font-medium">
                {wechatConnecting ? '连接中...' : wechatConnected ? '微信已连接' : '连接微信'}
              </span>
            </button>
          </div>
          {wechatMessage && !wechatConnecting && (
            <div className="w-full flex justify-center mt-2">
              <span className={`text-[12px] ${wechatConnected ? 'text-[#4CBF00]' : 'text-gray-400'}`}>
                {wechatMessage}
              </span>
            </div>
          )} */}
        </div>
        {skillMarketCategory && (
          <SkillMarketModal
            category={skillMarketCategory}
            onClose={() => setSkillMarketCategory(null)}
            onInstalled={(skillId) => {
              console.log('技能已安装:', skillId);
            }}
          />
        )}
        <AddFromGithubModal
          isOpen={showGithubModal}
          onClose={() => setShowGithubModal(false)}
          currentContextTokens={contextInfo?.tokens || 0}
          contextLimit={contextInfo?.limit || 200000}
          onConfirm={handleGithubAdd}
        />
        {sharedProjectOverlays}
        <ContextMenuContainer />
      </div>
    );
  }

  // MODE 2: Chat Interface (Has ID or Messages)
  const userMessageIndices = getUserMessageIndices();
  
  // 检测是否为运营对话
  const isDouyinOp = conversationTitle === '抖音运营';
  const isTikTokOp = conversationTitle === 'TikTok运营';
  const isOpConversation = isDouyinOp || isTikTokOp;
  
  // 运营功能列表 - 左边
  const opFeaturesLeft = [
    { id: 'login', name: '登录', icon: '🔑' },
    { id: 'intercept', name: '截流', icon: '🔗' },
    { id: 'message', name: '私信', icon: '💬' },
    { id: 'service', name: '客服', icon: '🎧' },
  ];
  // 运营功能列表 - 右边
  const opFeaturesRight = [
    { id: 'image', name: '一键图文生成发布', icon: '🖼️' },
    { id: 'video', name: '一键视频生成发布', icon: '🎬' },
    { id: 'data', name: '账号运营数据', icon: '📊' },
  ];
  
  return (
    <div className="flex-1 bg-simona-bg h-full flex flex-col overflow-clip text-simona-text chat-root chat-font-scope">
      {/* Content area - positioning container for scroll + bottom bars */}
      <div className="flex-1 min-h-0 relative">
        {/* 滚动指示器 - 右侧小圆点 */}
        {userMessageIndices.length > 1 && (
          <div
            className="absolute right-4 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-2 max-h-[480px] overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none] [scrollbar-color:transparent_transparent]"
            onMouseEnter={() => setVisibleDots(true)}
            onMouseLeave={() => setVisibleDots(false)}
          >
            {userMessageIndices.map((msgIdx, dotIdx) => {
              const userMsg = messages[msgIdx];
              const msgContent = (userMsg?.content || userMsg?.text || '').replace(/<[^>]+>/g, '');
              const truncated = msgContent.length > 60 ? msgContent.slice(0, 60) + '...' : msgContent;
              const label = truncated || `段落 ${dotIdx + 1}`;
              return (
                <div key={msgIdx} className="relative flex items-center justify-end">
                  <button
                    onClick={() => scrollToMessage(msgIdx)}
                    onMouseEnter={() => setHoveredDot(dotIdx)}
                    onMouseLeave={() => setHoveredDot(null)}
                    className={`w-2 h-2 rounded-full transition-all duration-200 ${
                      currentSectionIndex === dotIdx
                        ? 'bg-simona-accent scale-125'
                        : 'bg-simona-border hover:bg-simona-textSecondary'
                    } ${visibleDots ? 'opacity-100' : 'opacity-40'}`}
                    title={label}
                  />
                  {hoveredDot === dotIdx && (
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 whitespace-nowrap max-w-[280px] overflow-hidden text-ellipsis px-3 py-1.5 rounded-lg bg-simona-input border border-simona-border text-[12px] text-simona-text shadow-[0_4px_16px_rgba(0,0,0,0.15)] z-40 pointer-events-none">
                      {label}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div
          className="absolute inset-0 overflow-y-auto chat-scroll"
          style={{ paddingBottom: `${isAndroidApp && inputCollapsed ? 40 : inputHeight}px` }}
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onClick={() => { if (isAndroidApp && inputCollapsed) setInputCollapsed(false); }}
        >
          <div
            className="w-full mx-auto px-4 py-8 pb-2"
            style={{ maxWidth: `${tunerConfig?.mainContentWidth || 768}px`, zoom: isAndroidApp ? 0.78 : undefined }}
          >
            {/* 运营功能 - 左侧 */}
            {isOpConversation && (
              <div className="fixed left-[140px] top-1/2 -translate-y-1/2 z-20 flex flex-col gap-2" style={{ width: '100px' }}>
                {opFeaturesLeft.map((feat) => (
                  <button
                    key={feat.id}
                    onClick={() => console.log(`[运营面板-左] ${feat.name} 被点击`)}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg border bg-simona-input border-simona-border text-simona-textSecondary hover:text-simona-text hover:border-simona-accent/50 transition-all duration-200 active:scale-95 shadow-sm"
                  >
                    <span className="text-[16px]">{feat.icon}</span>
                    <span className="text-[12px] font-medium">{feat.name}</span>
                  </button>
                ))}
              </div>
            )}
            {/* 运营功能 - 右侧 */}
            {isOpConversation && (
              <div className="fixed right-[20px] top-1/2 -translate-y-1/2 z-20 flex flex-col gap-2" style={{ width: '100px' }}>
                {opFeaturesRight.map((feat) => (
                  <button
                    key={feat.id}
                    onClick={() => console.log(`[运营面板-右] ${feat.name} 被点击`)}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg border bg-simona-input border-simona-border text-simona-textSecondary hover:text-simona-text hover:border-simona-accent/50 transition-all duration-200 active:scale-95 shadow-sm"
                  >
                    <span className="text-[16px]">{feat.icon}</span>
                    <span className="text-[12px] font-medium">{feat.name}</span>
                  </button>
                ))}
              </div>
            )}
            <MessageList
              messages={messages}
              loading={loading}
              expandedMessages={expandedMessages}
              editingMessageIdx={editingMessageIdx}
              editingContent={editingContent}
              copiedMessageIdx={copiedMessageIdx}
              compactStatus={compactStatus}
              onSetEditingContent={setEditingContent}
              onEditCancel={handleEditCancel}
              onEditSave={handleEditSave}
              onToggleExpand={toggleMessageExpand}
              onResend={handleResendMessage}
              onDeleteRound={handleDeleteRound}
              onEdit={handleEditMessage}
              onCopy={handleCopyMessage}
              onOpenDocument={onOpenDocument}
              onSetMessages={setMessages}
              messageContentRefs={messageContentRefs}
              setOpenedResearchMsgId={setOpenedResearchMsgId}
            />
            
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* 集群进度面板 - 已移除，结果直接显示在对话中 */}

        {/* 免责声明 - 固定在最底部 */}
        <div className="absolute bottom-0 left-0 z-10 bg-simona-bg flex items-center justify-center text-[12px] text-simona-textSecondary h-7 pointer-events-none font-sans" style={{ right: `${scrollbarWidth}px` }}>
          Simona 是人工智能，可能会犯错。请仔细核对回复内容。
        </div>

        {/* 输入框 - 浮动在内容上方，底部距离可调 */}
        <div className="absolute left-0 right-0 z-20" style={{ bottom: `${(isAndroidApp && inputCollapsed ? -200 : 0) + 28}px`, paddingLeft: '16px', paddingRight: `${16 + scrollbarWidth}px`, pointerEvents: isAndroidApp && inputCollapsed ? 'none' : undefined }}>
          <div
            className="mx-auto pointer-events-auto"
            style={{ maxWidth: `${inputBarWidth}px` }}
          >
            <div className="w-full relative group" ref={inputWrapperRef}>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                multiple
                accept={ACCEPTED_TYPES}
                onChange={(e) => {
                  if (e.target.files) handleFilesSelected(e.target.files);
                  e.target.value = '';
                }}
              />
              <div
                className={`bg-simona-input border shadow-[0_2px_8px_rgba(0,0,0,0.02)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)] hover:border-[#CCC] dark:hover:border-[#5a5a58] focus-within:shadow-[0_2px_8px_rgba(0,0,0,0.08)] focus-within:border-[#CCC] dark:focus-within:border-[#5a5a58] transition-all duration-200 flex flex-col font-sans ${isDragging ? 'border-[#D97757] bg-orange-50/30' : 'border-simona-border dark:border-[#3a3a38]'}`}
                style={{ borderRadius: `${inputBarRadius}px` }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <FileUploadPreview files={pendingFiles} onRemove={handleRemoveFile} />
                <div className="relative">
                  <SkillInputOverlay
                    text={inputText}
                    className="px-4 pt-4 pb-0 text-[16px] font-sans font-[350]"
                    style={{ height: `${inputBarBaseHeight}px`, minHeight: '16px', boxSizing: 'border-box', overflow: 'hidden' }}
                  />
                  <textarea
                    ref={inputRef}
                    className={`w-full px-4 pt-4 pb-0 placeholder:text-simona-textSecondary text-[16px] outline-none resize-none bg-transparent font-sans font-[350] ${inputText.match(/^\/[a-zA-Z0-9_-]+/) ? 'text-transparent caret-simona-text' : 'text-simona-text'}`}
                    style={{ height: `${inputBarBaseHeight}px`, minHeight: '16px', boxSizing: 'border-box', overflowY: 'hidden' }}
                    placeholder={selectedSkill ? `描述您希望 ${selectedSkill.name} 做什么...` : "今天有什么可以帮您的？"}
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      adjustTextareaHeight();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Backspace' && selectedSkill) {
                        const pos = (e.target as HTMLTextAreaElement).selectionStart;
                        const skillPrefix = `/${selectedSkill.slug} `;
                        if (pos > 0 && pos <= skillPrefix.length && inputText.startsWith(skillPrefix.slice(0, pos))) {
                          e.preventDefault();
                          setInputText(inputText.slice(skillPrefix.length));
                          setSelectedSkill(null);
                          return;
                        }
                      }
                      handleKeyDown(e);
                    }}
                    onKeyUp={handleKeyUp}
                    onBeforeInput={handleBeforeInput}
                    onPaste={handlePaste}
                    onContextMenu={(e) => {
                      // 阻止默认菜单，显示自定义美化右键菜单
                      e.preventDefault();
                      const selection = window.getSelection()?.toString();
                      const selectedText = selection || '';
                      
                      // 构建菜单项
                      const menuItems: Array<{
                        label: string;
                        separator?: boolean;
                        disabled?: boolean;
                        onClick: () => void;
                      }> = [];

                      // 复制
                      menuItems.push({
                        label: '复制',
                        disabled: !selectedText,
                        onClick: () => { if (selectedText) navigator.clipboard.writeText(selectedText); }
                      });

                      // 剪切
                      menuItems.push({
                        label: '剪切',
                        disabled: !selectedText,
                        onClick: () => {
                          if (selectedText) {
                            navigator.clipboard.writeText(selectedText);
                            const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true });
                            inputRef.current?.dispatchEvent(event);
                          }
                        }
                      });

                      // 粘贴
                      menuItems.push({
                        label: '粘贴',
                        onClick: async () => {
                          try {
                            const text = await navigator.clipboard.readText();
                            const textarea = inputRef.current;
                            if (textarea) {
                              const start = textarea.selectionStart;
                              const end = textarea.selectionEnd;
                              const newValue = inputText.substring(0, start) + text + inputText.substring(end);
                              setInputText(newValue);
                              setTimeout(() => {
                                textarea.selectionStart = textarea.selectionEnd = start + text.length;
                                textarea.focus();
                              }, 0);
                            }
                          } catch (err) { console.error('[ContextMenu] Paste failed:', err); }
                        }
                      });

                      // 全选
                      menuItems.push({
                        label: '全选',
                        onClick: () => { inputRef.current?.select(); }
                      });
                      
                      // 搜索功能（仅当有选中文本时）
                      if (selectedText && selectedText.trim()) {
                        menuItems.push({
                          label: 'separator',
                          separator: true,
                          onClick: () => {}
                        });
                        
                        const searchText = selectedText.trim().length > 30 
                          ? selectedText.trim().substring(0, 30) + '...' 
                          : selectedText.trim();
                        menuItems.push({
                          label: `用 Google 搜索 "${searchText}"`,
                          icon: '🔍',
                          onClick: () => {
                            const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(selectedText.trim())}`;
                            window.open(searchUrl, '_blank');
                          }
                        });
                      }
                      
                      // 显示菜单
                      showContextMenu(e.clientX, e.clientY, menuItems, () => {});
                    }}
                  />
                </div>
                <div className="px-4 pb-3 pt-1 flex items-center justify-between">
                  <div className="relative flex items-center gap-1">
                    <button
                      ref={plusBtnRef}
                      onClick={() => setShowPlusMenu(prev => !prev)}
                      className="p-2 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded-lg transition-colors"
                    >
                      <IconPlus size={20} />
                    </button>
                    
                                        {showPlusMenu && (
                      <div
                        ref={plusMenuRef}
                        className="absolute bottom-full left-0 mb-2 w-[220px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1.5 z-50"
                      >
                        <button
                          onMouseEnter={() => { setShowSkillsSubmenu(false); setShowProjectsSubmenu(false); }}
                          onClick={() => {
                            setShowPlusMenu(false);
                            fileInputRef.current?.click();
                          }}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-simona-text hover:bg-simona-hover transition-colors"
                        >
                          <Paperclip size={16} className="text-simona-textSecondary" />
                          添加文件或图片
                        </button>
                        {/* Add to project submenu */}
                        <div className="relative" onMouseLeave={() => setShowProjectsSubmenu(false)}>
                          <button
                            onMouseEnter={() => { setShowProjectsSubmenu(true); setShowSkillsSubmenu(false); }}
                            onClick={() => setShowProjectsSubmenu(prev => !prev)}
                            className="w-full flex items-center justify-between px-4 py-2.5 text-[13px] text-simona-text hover:bg-simona-hover transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <IconProjects size={16} className="text-simona-textSecondary scale-[1.6] dark:[filter:brightness(0)_invert(1)_brightness(0.68)_sepia(0.18)]" />
                              添加到项目
                            </div>
                            <ChevronDown size={14} className="text-simona-textSecondary -rotate-90" />
                          </button>
                          {showProjectsSubmenu && (
                            <div className="absolute left-full bottom-0 w-[220px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1.5 z-50 max-h-[30vh] overflow-y-auto">
                              {projectList.length > 0 ? projectList.map(p => {
                                const isSelected = (activeId && currentProjectId === p.id) || (!activeId && pendingProjectId === p.id);
                                return (
                                  <button
                                    key={p.id}
                                    onClick={() => handleAttachToProject(p)}
                                    className="w-full flex items-center justify-between gap-2 px-4 py-2 text-[13px] text-simona-text hover:bg-simona-hover transition-colors text-left"
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <IconProjects size={26} className="text-simona-textSecondary flex-shrink-0 dark:[filter:brightness(0)_invert(1)_brightness(0.68)_sepia(0.18)]" />
                                      <span className="truncate">{p.name}</span>
                                    </div>
                                    {isSelected && <Check size={14} className="text-simona-textSecondary flex-shrink-0" />}
                                  </button>
                                );
                              }) : (
                                <div className="px-4 py-2 text-[12px] text-simona-textSecondary italic">暂无项目</div>
                              )}
                              <div className="border-t border-simona-border mt-1 pt-1">
                                <button
                                  onClick={() => {
                                    setShowProjectsSubmenu(false);
                                    setShowPlusMenu(false);
                                    setNewProjectName('');
                                    setNewProjectDescription('');
                                    setShowNewProjectDialog(true);
                                  }}
                                  className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-simona-textSecondary hover:bg-simona-hover transition-colors"
                                >
                                  <Plus size={14} />
                                  新建项目
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                        {/* Skills submenu */}
                        <div className="relative" onMouseLeave={() => setShowSkillsSubmenu(false)}>
                          <button
                            onMouseEnter={() => { setShowSkillsSubmenu(true); setShowProjectsSubmenu(false); }}
                            onClick={(e) => { e.stopPropagation(); setShowSkillsSubmenu(prev => !prev); }}
                            className="w-full flex items-center justify-between px-4 py-2.5 text-[13px] text-simona-text hover:bg-simona-hover transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <FileText size={16} className="text-simona-textSecondary" />
                              技能
                            </div>
                            <ChevronDown size={14} className="text-simona-textSecondary -rotate-90" />
                          </button>
                          {showSkillsSubmenu && enabledSkills.length > 0 && (
                            <div className="absolute left-full bottom-0 w-[220px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1.5 z-50 max-h-[30vh] overflow-y-auto">
                              {enabledSkills.map(skill => (
                                <button
                                  key={skill.id}
                                  onClick={() => {
                                    setShowPlusMenu(false);
                                    setShowSkillsSubmenu(false);
                                    const slug = skill.name.toLowerCase().replace(/\s+/g, '-');
                                    setSelectedSkill({ name: skill.name, slug, description: skill.description });
                                    setInputText(prev => prev ? `/${slug} ${prev}` : `/${slug} `);
                                    inputRef.current?.focus();
                                  }}
                                  className="w-full text-left px-4 py-2 text-[13px] text-simona-text hover:bg-simona-hover transition-colors truncate"
                                >
                                  {skill.name}
                                </button>
                              ))}
                              <div className="border-t border-simona-border mt-1 pt-1">
                                <button
                                  onClick={() => {
                                    setShowPlusMenu(false);
                                    setShowSkillsSubmenu(false);
                                    window.location.hash = '#/customize';
                                  }}
                                  className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-simona-textSecondary hover:bg-simona-hover transition-colors"
                                >
                                  <FileText size={14} />
                                  管理技能
                                </button>
                              </div>
                            </div>
                          )}
                          {showSkillsSubmenu && enabledSkills.length === 0 && (
                            <div className="absolute left-full bottom-0 w-[220px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1.5 z-50">
                              <div className="px-4 py-2 text-[12px] text-simona-textSecondary italic">暂无可用技能</div>
                              <div className="border-t border-simona-border mt-1 pt-1">
                                <button
                                  onClick={() => {
                                    setShowPlusMenu(false);
                                    window.location.hash = '#/customize';
                                  }}
                                  className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-simona-textSecondary hover:bg-simona-hover transition-colors"
                                >
                                  <FileText size={14} />
                                  管理技能
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <ModelSelector
                      currentModelString={currentModelString}
                      models={selectorModels}
                      onModelChange={handleModelChange}
                      isNewChat={false}
                      dropdownPosition="top"
                      clusterEnabled={clusterEnabled}
                      onClusterToggle={setClusterEnabled}
                      clusterAgentCount={clusterConfig.agentCount}
                      onClusterAgentCountChange={(count) => setClusterConfig({ ...clusterConfig, agentCount: count })}
                      showSwarmButton={showSwarmButton}
                    />
                    {/* 打开工作区文件夹 */}
                    <button
                      onClick={async () => {
                        if ((window as any).electronAPI?.openFolder) {
                          try {
                            const wsUrl = activeId
                              ? `http://127.0.0.1:30080/api/workspace/current?conversation_id=${activeId}`
                              : 'http://127.0.0.1:30080/api/workspace/current';
                            const wsRes = await fetch(wsUrl);
                            if (!wsRes.ok) return;
                            const wsData = await wsRes.json();
                            if (wsData.workspace_path) (window as any).electronAPI.openFolder(wsData.workspace_path);
                          } catch (e) { console.error('[Workspace] Open folder failed:', e); }
                        } else {
                          setShowFolderBrowser(true);
                        }
                      }}
                      onContextMenu={async (e) => {
                        e.preventDefault();
                        if ((window as any).electronAPI?.selectDirectory) {
                          try {
                            const result = await (window as any).electronAPI.selectDirectory();
                            if (!result) return;
                            await fetch('http://127.0.0.1:30080/api/workspace/set', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ workspace_path: result, conversation_id: activeId || undefined })
                            });
                          } catch (err) {
                            console.error('[Workspace] Select workspace failed:', err);
                          }
                        } else {
                          setShowFolderBrowser(true);
                        }
                      }}
                      className="p-1.5 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded-lg transition-colors"
                      title="打开工作区文件夹（右键选择目录）"
                    >
                      <Folder size={18} strokeWidth={1.5} />
                    </button>
                    {/* Token 计数 */}
                    {showTokenBar && (
                    <span className="text-[11px] whitespace-nowrap text-simona-textSecondary" title={`${(contextInfo?.tokens || 0).toLocaleString()} / 1,000,000 tokens`}>
                      {contextInfo?.tokens ? (contextInfo.tokens >= 1000 ? `${(contextInfo.tokens / 1000).toFixed(1)}K` : contextInfo.tokens) : '0'}
                    </span>
                    )}
                    {/* 手动压缩按钮 */}
                    <button
                      onClick={() => setShowCompactDialog(true)}
                      className="p-1.5 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded-lg transition-colors"
                      title="压缩对话 - 总结历史以释放上下文空间"
                    >
                      <ListCollapse size={18} strokeWidth={1.5} />
                    </button>
                    {/* 人设切换按钮 */}
                    {personas.length > 0 && (
                      <div className="relative" ref={personaDropdownRef}>
                        <button
                          onClick={() => setShowPersonaDropdown(!showPersonaDropdown)}
                          className={`px-2.5 py-1.5 text-[12px] font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                            currentPersonaId
                              ? 'bg-[#5B9BFF]/10 border border-[#5B9BFF]/30 text-[#5B9BFF]'
                              : 'bg-simona-input border border-simona-border text-simona-textSecondary hover:text-simona-text hover:border-simona-textSecondary'
                          }`}
                          title={currentPersonaId ? `当前人设: ${personas.find(p => p.id === currentPersonaId)?.name || '未命名'}` : '切换人设'}
                        >
                          <User size={14} />
                          {currentPersonaId ? personas.find(p => p.id === currentPersonaId)?.name : '人设'}
                        </button>
                        
                        {/* 人设下拉菜单 */}
                        {showPersonaDropdown && (
                          <div className="absolute bottom-full right-0 mb-2 w-[240px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-2 z-50">
                            <div className="px-3 py-2 border-b border-simona-border">
                              <div className="text-[12px] font-medium text-simona-textSecondary">选择人设</div>
                            </div>
                            <div className="max-h-[300px] overflow-y-auto">
                              {/* 无人设选项 */}
                              <button
                                onClick={() => handleSwitchPersona('')}
                                className={`w-full px-3 py-2.5 text-left hover:bg-simona-hover transition-colors ${
                                  !currentPersonaId ? 'bg-[#5B9BFF]/5' : ''
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <div className="w-7 h-7 rounded-full bg-simona-textSecondary/20 flex items-center justify-center flex-shrink-0">
                                    <User size={14} className="text-simona-textSecondary" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[13px] font-medium text-simona-text">无人设</div>
                                    <div className="text-[11px] text-simona-textSecondary">使用默认设置</div>
                                  </div>
                                  {!currentPersonaId && <Check size={14} className="text-[#5B9BFF]" />}
                                </div>
                              </button>
                              
                              {/* 人设列表 */}
                              {personas.map(persona => (
                                <button
                                  key={persona.id}
                                  onClick={() => handleSwitchPersona(persona.id)}
                                  className={`w-full px-3 py-2.5 text-left hover:bg-simona-hover transition-colors ${
                                    currentPersonaId === persona.id ? 'bg-[#5B9BFF]/5' : ''
                                  }`}
                                >
                                  <div className="flex items-center gap-2">
                                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-medium flex-shrink-0 ${
                                      currentPersonaId === persona.id ? 'bg-[#5B9BFF]' : 'bg-simona-textSecondary'
                                    }`}>
                                      {persona.name.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[13px] font-medium text-simona-text truncate">{persona.name}</div>
                                      {persona.description && (
                                        <div className="text-[11px] text-simona-textSecondary truncate">{persona.description}</div>
                                      )}
                                    </div>
                                    {currentPersonaId === persona.id && <Check size={14} className="text-[#5B9BFF]" />}
                                  </div>
                                </button>
                              ))}
                            </div>
                            <div className="px-3 py-2 border-t border-simona-border mt-1">
                              <button
                                onClick={() => {
                                  setShowPersonaDropdown(false);
                                  window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'general' } }));
                                }}
                                className="w-full text-[12px] text-[#5B9BFF] hover:text-[#4A8AE6] transition-colors"
                              >
                                + 管理人设
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {loading ? (
                      <button
                        onClick={handleStop}
                        className="p-2 text-simona-text hover:bg-simona-hover rounded-lg transition-colors"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleSend()}
                        disabled={(!inputText.trim() && !pendingFiles.some(f => f.status === 'done')) || pendingFiles.some(f => f.status === 'uploading')}
                        className={`p-2 rounded-lg transition-colors disabled:cursor-not-allowed ${
                          (!inputText.trim() && !pendingFiles.some(f => f.status === 'done')) || pendingFiles.some(f => f.status === 'uploading')
                            ? 'bg-simona-input text-simona-textSecondary/40'
                            : 'bg-simona-hover text-simona-text hover:bg-simona-btn-hover'
                        }`}
                      >
                        <ArrowUp size={22} strokeWidth={2.5} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {false && (
                <div className="mx-4 flex items-center justify-between px-4 py-1.5 bg-simona-bgSecondary border-x border-b border-simona-border rounded-b-xl text-simona-textSecondary text-xs pointer-events-auto">
                  <span>您当前没有可用套餐，无法发送消息</span>
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('open-upgrade'))}
                    className="px-2 py-0.5 bg-simona-btnHover hover:bg-simona-hover text-simona-text text-xs font-medium rounded transition-colors border border-simona-border hover:border-blue-500 hover:text-blue-600"
                  >
                    购买套餐
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Plan mode banner */}
      {planMode && (
        <div className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center pointer-events-none" style={{ paddingLeft: 'var(--sidebar-width, 260px)' }}>
          <div className="mt-2 px-4 py-1.5 bg-amber-500/90 text-white text-[13px] font-medium rounded-full shadow-lg pointer-events-auto flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            Plan Mode — Simona is planning, not executing
          </div>
        </div>
      )}

      {/* Active tasks progress */}
      {activeTasks.size > 0 && (
        <div className="fixed bottom-[140px] right-6 z-[90] flex flex-col gap-1.5 w-[320px] max-w-[320px]">
          {/* 标题条 —— 点击折叠/展开 */}
          <button
            onClick={() => setTasksCollapsed(c => !c)}
            className="flex items-center justify-between w-full px-3 py-2 bg-simona-bg border border-simona-border rounded-lg shadow-lg text-[13px] font-medium text-simona-text hover:bg-simona-hover transition-colors cursor-pointer"
            title={tasksCollapsed ? '展开任务' : '收起任务'}
          >
            <span className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-simona-textSecondary flex-shrink-0" />
              计划任务 ({activeTasks.size})
            </span>
            {tasksCollapsed ? (
              <ChevronUp size={15} className="text-simona-textSecondary flex-shrink-0" />
            ) : (
              <ChevronDown size={15} className="text-simona-textSecondary flex-shrink-0" />
            )}
          </button>
          {/* 展开时显示具体任务列表 */}
          {!tasksCollapsed && (
            <div className="flex flex-col gap-1.5">
              {Array.from(activeTasks.entries()).map(([taskId, task]) => (
                <div key={taskId} className="bg-simona-bg border border-simona-border rounded-lg px-3 py-2 shadow-lg flex items-center gap-2 text-[12px] text-simona-textSecondary animate-pulse">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin flex-shrink-0"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  <span className="truncate">{task.last_tool_name ? `${task.description} (${task.last_tool_name})` : task.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* AskUserQuestion dialog */}
      {askUserDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40">
          <div className="bg-simona-bg border border-simona-border rounded-2xl shadow-xl w-[480px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-[15px] font-semibold text-simona-text mb-1 flex items-center gap-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Simona needs your input
              </h3>
            </div>
            <div className="px-5 pb-4 flex flex-col gap-4">
              {askUserDialog.questions.map((q, qi) => (
                <div key={qi} className="flex flex-col gap-1.5">
                  <label className="text-[13px] font-medium text-simona-text">{q.question}</label>
                  {q.options && q.options.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {q.options.map((opt, oi) => {
                        const selected = askUserDialog.answers[q.question] === opt.label;
                        return (
                          <button
                            key={oi}
                            onClick={() => setAskUserDialog(prev => prev ? { ...prev, answers: { ...prev.answers, [q.question]: opt.label } } : null)}
                            className={`text-left px-3 py-2 rounded-lg border text-[13px] transition-colors ${selected ? 'border-[#C6613F] bg-[#C6613F]/10 text-simona-text' : 'border-simona-border hover:bg-simona-hover text-simona-textSecondary'}`}
                          >
                            <div className="font-medium text-simona-text">{opt.label}</div>
                            {opt.description && <div className="text-[12px] text-simona-textSecondary mt-0.5">{opt.description}</div>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <input
                      type="text"
                      className="w-full bg-simona-input border border-simona-border rounded-lg px-3 py-2 text-[13px] text-simona-text outline-none focus:border-simona-textSecondary/40 transition-colors"
                      placeholder="Type your answer..."
                      value={askUserDialog.answers[q.question] || ''}
                      onChange={e => setAskUserDialog(prev => prev ? { ...prev, answers: { ...prev.answers, [q.question]: e.target.value } } : null)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          document.getElementById('ask-user-submit-btn')?.click();
                        }
                      }}
                      autoFocus={qi === 0}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 pb-4">
              <button
                id="ask-user-submit-btn"
                onClick={async () => {
                  if (!askUserDialog || !activeId) return;
                  const { request_id, tool_use_id, answers } = askUserDialog;
                  setAskUserDialog(null);
                  try {
                    await answerUserQuestion(activeId, request_id, tool_use_id, answers);
                  } catch (err) {
                    console.error('Failed to send answer:', err);
                  }
                }}
                className="px-4 py-1.5 text-[13px] text-white bg-[#C6613F] hover:bg-[#D97757] rounded-lg transition-colors font-medium"
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tool permission approval dialog */}
      {permissionDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40">
          <div className="bg-simona-bg border border-simona-border rounded-2xl shadow-xl w-[480px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-simona-text flex items-center gap-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                允许执行此工具？
              </h3>
            </div>
            <div className="px-5 pb-4 flex flex-col gap-3">
              <div>
                <div className="text-[13px] font-medium text-simona-text mb-1">工具</div>
                <div className="px-3 py-2 rounded-lg bg-simona-input border border-simona-border text-[13px] text-simona-text font-mono">
                  {permissionDialog.tool_name}
                </div>
              </div>
              {permissionDialog.tool_input && Object.keys(permissionDialog.tool_input).length > 0 && (
                <div>
                  <div className="text-[13px] font-medium text-simona-text mb-1">参数</div>
                  <pre className="px-3 py-2 rounded-lg bg-simona-input border border-simona-border text-[12px] text-simona-textSecondary font-mono whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                    {JSON.stringify(permissionDialog.tool_input, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 pb-4">
              <button
                onClick={async () => {
                  if (!permissionDialog || !activeId) return;
                  const { request_id, tool_use_id } = permissionDialog;
                  setPermissionDialog(null);
                  try { await respondPermission(activeId, request_id, tool_use_id, 'deny'); }
                  catch (err) { console.error('Failed to deny permission:', err); }
                }}
                className="px-4 py-1.5 text-[13px] text-simona-textSecondary border border-simona-border hover:bg-simona-hover rounded-lg transition-colors font-medium"
              >
                拒绝
              </button>
              <button
                onClick={async () => {
                  if (!permissionDialog || !activeId) return;
                  const { request_id, tool_use_id } = permissionDialog;
                  setPermissionDialog(null);
                  try { await respondPermission(activeId, request_id, tool_use_id, 'allow'); }
                  catch (err) { console.error('Failed to allow permission:', err); }
                }}
                className="px-4 py-1.5 text-[13px] text-white bg-[#C6613F] hover:bg-[#D97757] rounded-lg transition-colors font-medium"
              >
                允许
              </button>
            </div>
          </div>
        </div>
      )}

      <AddFromGithubModal
        isOpen={showGithubModal}
        onClose={() => setShowGithubModal(false)}
        currentContextTokens={contextInfo?.tokens || 0}
        contextLimit={contextInfo?.limit || 200000}
        onConfirm={handleGithubAdd}
      />

      {/* Clawparrot login-required modal: shown when a non-logged-in clawparrot
          user tries to send their first message. Lets them go to login page or
          switch to self-hosted mode in settings. */}
      {showLoginRequired && (
        <>
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-simona-input border border-simona-border rounded-2xl shadow-xl w-[460px] overflow-hidden">
            <div className="px-6 pt-6 pb-4">
              <h3 className="text-[16px] font-semibold text-simona-text mb-3">需要登录 Clawparrot 账号</h3>
              <p className="text-[14px] text-simona-textSecondary leading-relaxed">
                你当前在 <span className="text-simona-text font-medium">Clawparrot</span> 模式下，需要登录 <span className="font-mono text-simona-text">clawparrot.com</span> 账号才能使用。
                <br /><br />
                如果你还没有账号，请先去 <span className="font-mono text-simona-text">clawparrot.com</span> 注册一个。
                <br /><br />
                或者你也可以在设置的 General 页面切换到 <span className="text-simona-text font-medium">自部署</span> 模式，用你自己的 API Key。
              </p>
            </div>
            <div className="px-5 pb-5 pt-2 flex flex-col gap-2">
              <button
                onClick={() => {
                  pendingLoginSendRef.current = null;
                  setShowLoginRequired(false);
                  navigate('/login');
                }}
                className="w-full px-5 py-2.5 text-[14px] font-medium bg-simona-text text-simona-bg hover:opacity-90 rounded-lg transition-opacity"
              >
                去登录
              </button>
              <button
                onClick={() => {
                  pendingLoginSendRef.current = null;
                  setShowLoginRequired(false);
                }}
                className="w-full px-5 py-1.5 text-[12px] text-simona-textSecondary hover:text-simona-text transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        </div>
        </>
      )}

      {/* Cross-mode warning 已禁用 */}

      {/* 压缩对话弹窗 */}
      {showCompactDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onClick={() => setShowCompactDialog(false)}>
          <div className="bg-simona-bg border border-simona-border rounded-2xl shadow-xl w-[440px] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-[15px] font-semibold text-simona-text mb-1">压缩对话</h3>
              <p className="text-[13px] text-simona-textSecondary leading-snug">
                总结对话历史以释放上下文空间。引擎将保留关键决策和上下文。
              </p>
            </div>
            <div className="px-5 pb-3">
              <textarea
                className="w-full bg-simona-input border border-simona-border rounded-lg px-3 py-2 text-[13px] text-simona-text placeholder:text-simona-textSecondary/50 outline-none focus:border-simona-textSecondary/40 transition-colors resize-none"
                rows={3}
                placeholder="可选：添加总结说明（例如：保留所有API端点详情）"
                value={compactInstruction}
                onChange={e => setCompactInstruction(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    document.getElementById('compact-confirm-btn')?.click();
                  }
                }}
                autoFocus
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-5 pb-4">
              <button
                onClick={() => setShowCompactDialog(false)}
                className="px-3.5 py-1.5 text-[13px] text-simona-textSecondary hover:text-simona-text rounded-lg hover:bg-simona-hover transition-colors"
              >
                取消
              </button>
              <button
                id="compact-confirm-btn"
                onClick={async () => {
                  setShowCompactDialog(false);
                  if (!activeId || compactStatus.state === 'compacting') return;
                  setCompactStatus({ state: 'compacting' });
                  try {
                    const instruction = compactInstruction.trim() || undefined;
                    const result = await compactConversation(activeId, instruction);
                    await loadConversation(activeId);
                    const newContextInfo = await getContextSize(activeId);
                    setContextInfo(newContextInfo);
                    setCompactStatus({ state: 'done', message: `已压缩 ${result.messagesCompacted} 条消息，节省约 ${result.tokensSaved} tokens` });
                    setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
                  } catch (err) {
                    console.error('压缩失败:', err);
                    setCompactStatus({ state: 'error', message: '压缩失败' });
                    setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
                  }
                }}
                className="px-3.5 py-1.5 text-[13px] text-white bg-[#C6613F] hover:bg-[#D97757] rounded-lg transition-colors font-medium"
              >
                压缩
              </button>
            </div>
          </div>
        </div>
      )}

      
      {sharedProjectOverlays}

      {/* Research panel — fixed right-side drawer */}
      {openedResearchMsgId && (() => {
        const liveMsg = messages.find(m => m.id === openedResearchMsgId);
        if (!liveMsg || !liveMsg.research) return null;
        return (
          <>
            <div
              className="fixed inset-0 z-[60] bg-black/20"
              onClick={() => setOpenedResearchMsgId(null)}
            />
            <div className="fixed top-0 right-0 bottom-0 w-[440px] z-[61] bg-simona-bg border-l border-simona-border shadow-2xl flex flex-col">
              <ResearchPanel research={liveMsg.research} onClose={() => setOpenedResearchMsgId(null)} />
            </div>
          </>
        );
      })()}
      {/* 微信登录二维码弹窗 */}
      {wechatQrVisible && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => {
          stopQrPolling();
          setWechatQrVisible(false);
        }}>
          <div className="bg-white dark:bg-[#2A2A2A] rounded-2xl shadow-2xl p-6 max-w-sm w-full text-center" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[18px] font-semibold text-gray-800 dark:text-white">微信登录</h3>
              <button
                onClick={() => {
                  stopQrPolling();
                  setWechatQrVisible(false);
                }}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
              >
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            {wechatQrLoading && !wechatQrUrl ? (
              <div className="py-12">
                <Loader2 size={48} className="animate-spin mx-auto text-[#4B9EFA]" />
                <p className="mt-4 text-gray-500">正在获取二维码...</p>
              </div>
            ) : wechatQrUrl ? (
              <>
                <div className="bg-white rounded-lg p-2 mb-4">
                  <img
                    src={wechatQrUrl}
                    alt="微信登录二维码"
                    className="w-[200px] h-[200px] object-contain mx-auto"
                    onError={() => {
                      // 图片加载失败，重新获取
                      fetchWechatQrCode().then(url => {
                        if (url) setWechatQrUrl(url);
                      });
                    }}
                  />
                </div>
                <p className="text-[14px] text-gray-600 dark:text-gray-300 mb-2">
                  请使用微信扫描下方二维码登录
                </p>
                <p className="text-[12px] text-gray-400">
                  二维码将在 3 分钟内过期
                </p>
                <button
                  onClick={() => {
                    fetchWechatQrCode().then(url => {
                      if (url) setWechatQrUrl(url);
                    });
                  }}
                  className="mt-4 px-4 py-2 text-[13px] text-[#4B9EFA] hover:text-[#3A8EE6] font-medium transition-colors"
                >
                  刷新二维码
                </button>
              </>
            ) : (
              <div className="py-8">
                <p className="text-gray-500">无法获取二维码，请重试</p>
                <button
                  onClick={async () => {
                    setWechatQrLoading(true);
                    const url = await fetchWechatQrCode();
                    if (url) {
                      setWechatQrUrl(url);
                    } else {
                      setWechatQrLoading(false);
                    }
                  }}
                  className="mt-4 px-4 py-2 text-[13px] text-white bg-[#4B9EFA] hover:bg-[#3A8EE6] rounded-lg transition-colors"
                >
                  重试
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 右键菜单组件 */}
      <ContextMenuContainer />
      {/* 浮动复制按钮 */}
      <FloatingCopyButton />
    </div>
  );
};

// Expose to window for debugging in DevTools console
if (typeof window !== 'undefined') {
  (window as any).forceClearPersonaData = () => {
    try {
      const profile = JSON.parse(localStorage.getItem('user_profile') || '{}');
      const userData = JSON.parse(localStorage.getItem('user') || '{}');
      
      let cleaned = false;
      
      if (profile.work_function?.includes('林墨') || profile.work_function?.includes('后端架构师')) {
        delete profile.work_function;
        delete profile.personal_preferences;
        localStorage.setItem('user_profile', JSON.stringify(profile));
        cleaned = true;
      }
      
      if (userData.work_function?.includes('林墨') || userData.work_function?.includes('后端架构师')) {
        delete userData.work_function;
        delete userData.personal_preferences;
        localStorage.setItem('user', JSON.stringify(userData));
        cleaned = true;
      }
      
      const origProfile = JSON.parse(localStorage.getItem('original_user_profile') || '{}');
      if (origProfile.work_function?.includes('林墨') || origProfile.work_function?.includes('后端架构师')) {
        localStorage.removeItem('original_user_profile');
        localStorage.removeItem('original_user');
        cleaned = true;
      }
      
      console.log('[Persona] Cleaned Linmo residue:', cleaned);
      if (cleaned) alert('已清除林墨残留数据，请刷新页面');
    } catch (err) {
      console.error('[Persona] Failed to clean:', err);
    }
  };
}

export default MainContent;



