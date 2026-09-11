import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import { getOauthConfig } from 'src/constants/oauth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getSimonaAIOAuthTokens } from 'src/utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvDefinedFalsy } from 'src/utils/envUtils.js'
import { clearMcpAuthCache } from './client.js'
import { normalizeNameForMCP } from './normalization.js'
import type { ScopedMcpServerConfig } from './types.js'

type SimonaAIMcpServer = {
  type: 'mcp_server'
  id: string
  display_name: string
  url: string
  created_at: string
}

type SimonaAIMcpServersResponse = {
  data: SimonaAIMcpServer[]
  has_more: boolean
  next_page: string | null
}

const FETCH_TIMEOUT_MS = 5000
const MCP_SERVERS_BETA_HEADER = 'mcp-servers-2025-12-04'

/**
 * Fetches MCP server configurations from Simona.ai org configs.
 * These servers are managed by the organization via Simona.ai.
 *
 * Results are memoized for the session lifetime (fetch once per CLI session).
 */
export const fetchSimonaAIMcpConfigsIfEligible = memoize(
  async (): Promise<Record<string, ScopedMcpServerConfig>> => {
    try {
      if (isEnvDefinedFalsy(process.env.ENABLE_SIMONAAI_MCP_SERVERS)) {
        logForDebugging('[simonaai-mcp] Disabled via env var')
        logEvent('tengu_simonaai_mcp_eligibility', {
          state:
            'disabled_env_var' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      const tokens = getSimonaAIOAuthTokens()
      if (!tokens?.accessToken) {
        logForDebugging('[simonaai-mcp] No access token')
        logEvent('tengu_simonaai_mcp_eligibility', {
          state:
            'no_oauth_token' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      // Check for user:mcp_servers scope directly instead of isSimonaAISubscriber().
      // In non-interactive mode, isSimonaAISubscriber() returns false when SIMONA_API_KEY
      // is set (even with valid OAuth tokens) because preferThirdPartyAuthentication() causes
      // isSimonaAuthEnabled() to return false. Checking the scope directly allows users
      // with both API keys and OAuth tokens to access simona.ai MCPs in print mode.
      if (!tokens.scopes?.includes('user:mcp_servers')) {
        logForDebugging(
          `[simonaai-mcp] Missing user:mcp_servers scope (scopes=${tokens.scopes?.join(',') || 'none'})`,
        )
        logEvent('tengu_simonaai_mcp_eligibility', {
          state:
            'missing_scope' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      const baseUrl = getOauthConfig().BASE_API_URL
      const url = `${baseUrl}/v1/mcp_servers?limit=1000`

      logForDebugging(`[simonaai-mcp] Fetching from ${url}`)

      const response = await axios.get<SimonaAIMcpServersResponse>(url, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json',
          'simona-beta': MCP_SERVERS_BETA_HEADER,
          'simona-version': '2023-06-01',
        },
        timeout: FETCH_TIMEOUT_MS,
      })

      const configs: Record<string, ScopedMcpServerConfig> = {}
      // Track used normalized names to detect collisions and assign (2), (3), etc. suffixes.
      // We check the final normalized name (including suffix) to handle edge cases where
      // a suffixed name collides with another server's base name (e.g., "Example Server 2"
      // colliding with "Example Server! (2)" which both normalize to simona_ai_Example_Server_2).
      const usedNormalizedNames = new Set<string>()

      for (const server of response.data.data) {
        const baseName = `simona.ai ${server.display_name}`

        // Try without suffix first, then increment until we find an unused normalized name
        let finalName = baseName
        let finalNormalized = normalizeNameForMCP(finalName)
        let count = 1
        while (usedNormalizedNames.has(finalNormalized)) {
          count++
          finalName = `${baseName} (${count})`
          finalNormalized = normalizeNameForMCP(finalName)
        }
        usedNormalizedNames.add(finalNormalized)

        configs[finalName] = {
          type: 'simonaai-proxy',
          url: server.url,
          id: server.id,
          scope: 'simonaai',
        }
      }

      logForDebugging(
        `[simonaai-mcp] Fetched ${Object.keys(configs).length} servers`,
      )
      logEvent('tengu_simonaai_mcp_eligibility', {
        state:
          'eligible' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return configs
    } catch {
      logForDebugging(`[simonaai-mcp] Fetch failed`)
      return {}
    }
  },
)

/**
 * Clears the memoized cache for fetchSimonaAIMcpConfigsIfEligible.
 * Call this after login so the next fetch will use the new auth tokens.
 */
export function clearSimonaAIMcpConfigsCache(): void {
  fetchSimonaAIMcpConfigsIfEligible.cache.clear?.()
  // Also clear the auth cache so freshly-authorized servers get re-connected
  clearMcpAuthCache()
}

/**
 * Record that a simona.ai connector successfully connected. Idempotent.
 *
 * Gates the "N connectors unavailable/need auth" startup notifications: a
 * connector that was working yesterday and is now failed is a state change
 * worth surfacing; an org-configured connector that's been needs-auth since
 * it showed up is one the user has demonstrably ignored.
 */
export function markSimonaAiMcpConnected(name: string): void {
  saveGlobalConfig(current => {
    const seen = current.simonaAiMcpEverConnected ?? []
    if (seen.includes(name)) return current
    return { ...current, simonaAiMcpEverConnected: [...seen, name] }
  })
}

export function hasSimonaAiMcpEverConnected(name: string): boolean {
  return (getGlobalConfig().simonaAiMcpEverConnected ?? []).includes(name)
}
