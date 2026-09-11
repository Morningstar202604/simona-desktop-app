import Simona, { type ClientOptions } from '@simona-ai/sdk'
import { randomUUID } from 'crypto'
import type { GoogleAuth } from 'google-auth-library'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getSimonaApiKey,
  getApiKeyFromApiKeyHelper,
  getSimonaAIOAuthTokens,
  isSimonaAISubscriber,
  refreshAndGetAwsCredentials,
  refreshGcpCredentialsIfNeeded,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import { getSmallFastModel } from 'src/utils/model/model.js'
import {
  getAPIProvider,
  isFirstPartySimonaBaseUrl,
} from 'src/utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import {
  getAWSRegion,
  getVertexRegionForModel,
  isEnvTruthy,
} from '../../utils/envUtils.js'

/**
 * Environment variables for different client types:
 *
 * Direct API:
 * - SIMONA_API_KEY: Required for direct API access
 *
 * AWS Bedrock:
 * - AWS credentials configured via aws-sdk defaults
 * - AWS_REGION or AWS_DEFAULT_REGION: Sets the AWS region for all models (default: us-east-1)
 * - SIMONA_SMALL_FAST_MODEL_AWS_REGION: Optional. Override AWS region specifically for the small fast model (Haiku)
 *
 * Foundry (Azure):
 * - SIMONA_FOUNDRY_RESOURCE: Your Azure resource name (e.g., 'my-resource')
 *   For the full endpoint: https://{resource}.services.ai.azure.com/simona/v1/messages
 * - SIMONA_FOUNDRY_BASE_URL: Optional. Alternative to resource - provide full base URL directly
 *   (e.g., 'https://my-resource.services.ai.azure.com')
 *
 * Authentication (one of the following):
 * - SIMONA_FOUNDRY_API_KEY: Your Microsoft Foundry API key (if using API key auth)
 * - Azure AD authentication: If no API key is provided, uses DefaultAzureCredential
 *   which supports multiple auth methods (environment variables, managed identity,
 *   Azure CLI, etc.). See: https://docs.microsoft.com/en-us/javascript/api/@azure/identity
 *
 * Vertex AI:
 * - Model-specific region variables (highest priority):
 *   - VERTEX_REGION_SIMONA_3_5_HAIKU: Region for Simona 3.5 Haiku model
 *   - VERTEX_REGION_SIMONA_HAIKU_4_5: Region for Simona Haiku 4.5 model
 *   - VERTEX_REGION_SIMONA_3_5_SONNET: Region for Simona 3.5 Sonnet model
 *   - VERTEX_REGION_SIMONA_3_7_SONNET: Region for Simona 3.7 Sonnet model
 * - CLOUD_ML_REGION: Optional. The default GCP region to use for all models
 *   If specific model region not specified above
 * - SIMONA_VERTEX_PROJECT_ID: Required. Your GCP project ID
 * - Standard GCP credentials configured via google-auth-library
 *
 * Priority for determining region:
 * 1. Hardcoded model-specific environment variables
 * 2. Global CLOUD_ML_REGION variable
 * 3. Default region from config
 * 4. Fallback region (us-east5)
 */

function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Simona SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Simona SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Simona SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Simona SDK DEBUG]', msg, ...args),
  }
}

export async function getSimonaClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Simona> {
  const containerId = process.env.SIMONA_CODE_CONTAINER_ID
  const remoteSessionId = process.env.SIMONA_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.SIMONA_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    'User-Agent': getUserAgent(),
    ...customHeaders,
  }

  // Log API client configuration for HFI debugging
  logForDebugging(
    `[API:request] Creating client, SIMONA_CUSTOM_HEADERS present: ${!!process.env.SIMONA_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // Add additional protection header if enabled via env var
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.SIMONA_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-simona-additional-protection'] = 'true'
  }

  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  logForDebugging('[API:auth] OAuth token check complete')

  if (!isSimonaAISubscriber()) {
    await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
  }

  const resolvedFetch = buildFetch(fetchOverride, source)

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forSimonaAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }
  if (isEnvTruthy(process.env.SIMONA_CODE_USE_BEDROCK)) {
    const { SimonaBedrock } = await import('@simona-ai/bedrock-sdk')
    // Use region override for small fast model if specified
    const awsRegion =
      model === getSmallFastModel() &&
      process.env.SIMONA_SMALL_FAST_MODEL_AWS_REGION
        ? process.env.SIMONA_SMALL_FAST_MODEL_AWS_REGION
        : getAWSRegion()

    const bedrockArgs: ConstructorParameters<typeof SimonaBedrock>[0] = {
      ...ARGS,
      awsRegion,
      ...(isEnvTruthy(process.env.SIMONA_CODE_SKIP_BEDROCK_AUTH) && {
        skipAuth: true,
      }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }

    // Add API key authentication if available
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      bedrockArgs.skipAuth = true
      // Add the Bearer token for Bedrock API key authentication
      bedrockArgs.defaultHeaders = {
        ...bedrockArgs.defaultHeaders,
        Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
      }
    } else if (!isEnvTruthy(process.env.SIMONA_CODE_SKIP_BEDROCK_AUTH)) {
      // Refresh auth and get credentials with cache clearing
      const cachedCredentials = await refreshAndGetAwsCredentials()
      if (cachedCredentials) {
        bedrockArgs.awsAccessKey = cachedCredentials.accessKeyId
        bedrockArgs.awsSecretKey = cachedCredentials.secretAccessKey
        bedrockArgs.awsSessionToken = cachedCredentials.sessionToken
      }
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new SimonaBedrock(bedrockArgs) as unknown as Simona
  }
  if (isEnvTruthy(process.env.SIMONA_CODE_USE_FOUNDRY)) {
    const { SimonaFoundry } = await import('@simona-ai/foundry-sdk')
    // Determine Azure AD token provider based on configuration
    // SDK reads SIMONA_FOUNDRY_API_KEY by default
    let azureADTokenProvider: (() => Promise<string>) | undefined
    if (!process.env.SIMONA_FOUNDRY_API_KEY) {
      if (isEnvTruthy(process.env.SIMONA_CODE_SKIP_FOUNDRY_AUTH)) {
        // Mock token provider for testing/proxy scenarios (similar to Vertex mock GoogleAuth)
        azureADTokenProvider = () => Promise.resolve('')
      } else {
        // Use real Azure AD authentication with DefaultAzureCredential
        const {
          DefaultAzureCredential: AzureCredential,
          getBearerTokenProvider,
        } = await import('@azure/identity')
        azureADTokenProvider = getBearerTokenProvider(
          new AzureCredential(),
          'https://cognitiveservices.azure.com/.default',
        )
      }
    }

    const foundryArgs: ConstructorParameters<typeof SimonaFoundry>[0] = {
      ...ARGS,
      ...(azureADTokenProvider && { azureADTokenProvider }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new SimonaFoundry(foundryArgs) as unknown as Simona
  }
  if (isEnvTruthy(process.env.SIMONA_CODE_USE_VERTEX)) {
    // Refresh GCP credentials if gcpAuthRefresh is configured and credentials are expired
    // This is similar to how we handle AWS credential refresh for Bedrock
    if (!isEnvTruthy(process.env.SIMONA_CODE_SKIP_VERTEX_AUTH)) {
      await refreshGcpCredentialsIfNeeded()
    }

    const [{ SimonaVertex }, { GoogleAuth }] = await Promise.all([
      import('@simona-ai/vertex-sdk'),
      import('google-auth-library'),
    ])
    // TODO: Cache either GoogleAuth instance or AuthClient to improve performance
    // Currently we create a new GoogleAuth instance for every getSimonaClient() call
    // This could cause repeated authentication flows and metadata server checks
    // However, caching needs careful handling of:
    // - Credential refresh/expiration
    // - Environment variable changes (GOOGLE_APPLICATION_CREDENTIALS, project vars)
    // - Cross-request auth state management
    // See: https://github.com/googleapis/google-auth-library-nodejs/issues/390 for caching challenges

    // Prevent metadata server timeout by providing projectId as fallback
    // google-auth-library checks project ID in this order:
    // 1. Environment variables (GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT, etc.)
    // 2. Credential files (service account JSON, ADC file)
    // 3. gcloud config
    // 4. GCE metadata server (causes 12s timeout outside GCP)
    //
    // We only set projectId if user hasn't configured other discovery methods
    // to avoid interfering with their existing auth setup

    // Check project environment variables in same order as google-auth-library
    // See: https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts
    const hasProjectEnvVar =
      process.env['GCLOUD_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      process.env['gcloud_project'] ||
      process.env['google_cloud_project']

    // Check for credential file paths (service account or ADC)
    // Note: We're checking both standard and lowercase variants to be safe,
    // though we should verify what google-auth-library actually checks
    const hasKeyFile =
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
      process.env['google_application_credentials']

    const googleAuth = isEnvTruthy(process.env.SIMONA_CODE_SKIP_VERTEX_AUTH)
      ? ({
          // Mock GoogleAuth for testing/proxy scenarios
          getClient: () => ({
            getRequestHeaders: () => ({}),
          }),
        } as unknown as GoogleAuth)
      : new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          // Only use SIMONA_VERTEX_PROJECT_ID as last resort fallback
          // This prevents the 12-second metadata server timeout when:
          // - No project env vars are set AND
          // - No credential keyfile is specified AND
          // - ADC file exists but lacks project_id field
          //
          // Risk: If auth project != API target project, this could cause billing/audit issues
          // Mitigation: Users can set GOOGLE_CLOUD_PROJECT to override
          ...(hasProjectEnvVar || hasKeyFile
            ? {}
            : {
                projectId: process.env.SIMONA_VERTEX_PROJECT_ID,
              }),
        })

    const vertexArgs: ConstructorParameters<typeof SimonaVertex>[0] = {
      ...ARGS,
      region: getVertexRegionForModel(model),
      googleAuth,
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new SimonaVertex(vertexArgs) as unknown as Simona
  }

  // Determine authentication method based on available tokens
  const clientConfig: ConstructorParameters<typeof Simona>[0] = {
    apiKey: isSimonaAISubscriber() ? null : apiKey || getSimonaApiKey(),
    authToken: isSimonaAISubscriber()
      ? getSimonaAIOAuthTokens()?.accessToken
      : undefined,
    // FIX: Support SIMONA_BASE_URL environment variable for proxy/custom endpoints
    // Priority: OAuth config > SIMONA_BASE_URL env > default
    ...(process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : process.env.SIMONA_BASE_URL
        ? { baseURL: process.env.SIMONA_BASE_URL }
        : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return getMemoizedClient(clientConfig, source)
}

// PERF: memoize Simona client instances by connection identity. An agentic
// turn makes N API requests (one per tool-use round); previously every round
// rebuilt the client and its config. Key includes everything that can change
// the connection, so a key/baseURL/timeout change still yields a fresh client.
const CLIENT_CACHE_MAX = 8
const clientCache = new Map<string, Simona>()

function getMemoizedClient(
  clientConfig: ConstructorParameters<typeof Simona>[0],
  source: string | undefined,
): Simona {
  const key = JSON.stringify([
    clientConfig.apiKey ?? null,
    clientConfig.authToken ?? null,
    clientConfig.baseURL ?? null,
    clientConfig.maxRetries ?? null,
    clientConfig.timeout ?? null,
    // fetch identity matters when callers pass fetchOverride (e.g. counting
    // wrappers); source is part of the wrapped fetch's behavior via logging.
    clientConfig.fetch ? source ?? 'override' : null,
  ])
  const cached = clientCache.get(key)
  if (cached) return cached
  const client = new Simona(clientConfig)
  if (clientCache.size >= CLIENT_CACHE_MAX) {
    // Evict oldest entry to bound memory (OAuth refresh changes authToken,
    // which would otherwise accumulate stale clients).
    const oldest = clientCache.keys().next().value
    if (oldest !== undefined) clientCache.delete(oldest)
  }
  clientCache.set(key, client)
  return client
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  const token =
    process.env.SIMONA_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.SIMONA_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // Split by newlines to support multiple headers
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    // Parse header in format "Name: Value" (curl style). Split on first `:`
    // then trim — avoids regex backtracking on malformed long header lines.
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  // Only send to the first-party API — Bedrock/Vertex/Foundry don't log it
  // and unknown headers risk rejection by strict proxies (inc-4029 class).
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartySimonaBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // Generate a client-side request ID so timeouts (which return no server
    // request ID) can still be correlated with server logs by the API team.
    // Callers that want to track the ID themselves can pre-set the header.
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // never let logging crash the fetch
    }
    return inner(input, { ...init, headers })
  }
}
