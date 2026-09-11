import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.SIMONA_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.SIMONA_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.SIMONA_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if SIMONA_BASE_URL is a first-party Simona API URL.
 * Returns true if not set (default API) or points to api.simona.com
 * (or api-staging.simona.com for ant users).
 */
export function isFirstPartySimonaBaseUrl(): boolean {
  const baseUrl = process.env.SIMONA_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.simona.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.simona.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
