// Content for the simona-api bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import csharpSimonaApi from './simona-api/csharp/simona-api.md'
import curlExamples from './simona-api/curl/examples.md'
import goSimonaApi from './simona-api/go/simona-api.md'
import javaSimonaApi from './simona-api/java/simona-api.md'
import phpSimonaApi from './simona-api/php/simona-api.md'
import pythonAgentSdkPatterns from './simona-api/python/agent-sdk/patterns.md'
import pythonAgentSdkReadme from './simona-api/python/agent-sdk/README.md'
import pythonSimonaApiBatches from './simona-api/python/simona-api/batches.md'
import pythonSimonaApiFilesApi from './simona-api/python/simona-api/files-api.md'
import pythonSimonaApiReadme from './simona-api/python/simona-api/README.md'
import pythonSimonaApiStreaming from './simona-api/python/simona-api/streaming.md'
import pythonSimonaApiToolUse from './simona-api/python/simona-api/tool-use.md'
import rubySimonaApi from './simona-api/ruby/simona-api.md'
import skillPrompt from './simona-api/SKILL.md'
import sharedErrorCodes from './simona-api/shared/error-codes.md'
import sharedLiveSources from './simona-api/shared/live-sources.md'
import sharedModels from './simona-api/shared/models.md'
import sharedPromptCaching from './simona-api/shared/prompt-caching.md'
import sharedToolUseConcepts from './simona-api/shared/tool-use-concepts.md'
import typescriptAgentSdkPatterns from './simona-api/typescript/agent-sdk/patterns.md'
import typescriptAgentSdkReadme from './simona-api/typescript/agent-sdk/README.md'
import typescriptSimonaApiBatches from './simona-api/typescript/simona-api/batches.md'
import typescriptSimonaApiFilesApi from './simona-api/typescript/simona-api/files-api.md'
import typescriptSimonaApiReadme from './simona-api/typescript/simona-api/README.md'
import typescriptSimonaApiStreaming from './simona-api/typescript/simona-api/streaming.md'
import typescriptSimonaApiToolUse from './simona-api/typescript/simona-api/tool-use.md'

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
// After updating these constants, manually update the two files that still hardcode models:
//   - simona-api/SKILL.md (Current Models pricing table)
//   - simona-api/shared/models.md (full model catalog with legacy versions and alias mappings)
export const SKILL_MODEL_VARS = {
  OPUS_ID: 'simona-opus-4-6',
  OPUS_NAME: 'Simona Opus 4.6',
  SONNET_ID: 'simona-sonnet-4-6',
  SONNET_NAME: 'Simona Sonnet 4.6',
  HAIKU_ID: 'simona-haiku-4-5',
  HAIKU_NAME: 'Simona Haiku 4.5',
  // Previous Sonnet ID — used in "do not append date suffixes" example in SKILL.md.
  PREV_SONNET_ID: 'simona-sonnet-4-5',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  'csharp/simona-api.md': csharpSimonaApi,
  'curl/examples.md': curlExamples,
  'go/simona-api.md': goSimonaApi,
  'java/simona-api.md': javaSimonaApi,
  'php/simona-api.md': phpSimonaApi,
  'python/agent-sdk/README.md': pythonAgentSdkReadme,
  'python/agent-sdk/patterns.md': pythonAgentSdkPatterns,
  'python/simona-api/README.md': pythonSimonaApiReadme,
  'python/simona-api/batches.md': pythonSimonaApiBatches,
  'python/simona-api/files-api.md': pythonSimonaApiFilesApi,
  'python/simona-api/streaming.md': pythonSimonaApiStreaming,
  'python/simona-api/tool-use.md': pythonSimonaApiToolUse,
  'ruby/simona-api.md': rubySimonaApi,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/live-sources.md': sharedLiveSources,
  'shared/models.md': sharedModels,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
  'typescript/agent-sdk/README.md': typescriptAgentSdkReadme,
  'typescript/agent-sdk/patterns.md': typescriptAgentSdkPatterns,
  'typescript/simona-api/README.md': typescriptSimonaApiReadme,
  'typescript/simona-api/batches.md': typescriptSimonaApiBatches,
  'typescript/simona-api/files-api.md': typescriptSimonaApiFilesApi,
  'typescript/simona-api/streaming.md': typescriptSimonaApiStreaming,
  'typescript/simona-api/tool-use.md': typescriptSimonaApiToolUse,
}
