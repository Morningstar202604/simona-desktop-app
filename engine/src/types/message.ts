/**
 * Message types for the Simona Code engine.
 * 
 * This module defines the core message types used throughout the application
 * for representing conversation messages between users and assistants.
 */

export type MessageType = 'user' | 'assistant' | 'system' | 'meta'

export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<TextContent>
  is_error?: boolean
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent

export interface Message {
  id: string
  type: MessageType
  role: 'user' | 'assistant'
  message: {
    content: ContentBlock[]  // API返回的消息内容总是ContentBlock数组
  }
  timestamp?: string
  created_at?: string
  isMeta?: boolean
  origin?: {
    kind: 'human' | 'ai' | 'system'
  }
  // Additional fields that may be present
  thinking?: string
  searchStatus?: unknown
  searchLogs?: unknown[]
  _contentLenBeforeSearch?: number
  isThinking?: boolean
  toolCalls?: unknown[]
  research?: {
    sub_agents?: unknown[]
    sources?: unknown[]
    phase?: string | null
    plan?: unknown
    report?: unknown
    completed?: boolean
  }
  is_summary?: number
  is_compact_boundary?: boolean
}

export interface NormalizedUserMessage extends Message {
  type: 'user'
  role: 'user'
}

export interface AssistantMessage extends Message {
  type: 'assistant'
  role: 'assistant'
}
