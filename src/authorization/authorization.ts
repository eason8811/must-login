import { createHash } from 'node:crypto';

import { init as initModuleLexer, parse as parseModule } from 'es-module-lexer';

import type { SignLogger } from '../sign/sign.js';

/** Logger contract for Authorization discovery; identical to the Sign logger. */
export interface AuthorizationLogger extends SignLogger {}

/**
 * Options for extracting the Authorization header embedded in the current X bundle.
 *
 * The downloaded JavaScript is inspected as text and is never imported or run.
 * Consequently this API does not require `allowRemoteSdkExecution`.
 */
export interface AuthorizationOptions {
  /** Print detailed resource discovery events. Default: false. */
  verbose?: boolean;
  /** HTML request timeout in milliseconds. Default: 15000. */
  fetchTimeoutMs?: number;
  /** Timeout for each JavaScript CDN download in milliseconds. Default: 15000. */
  sdkFetchTimeoutMs?: number;
  /** Headers merged into the default HTML request headers. */
  htmlHeaders?: Readonly<Record<string, string>>;
  /** Headers merged into the default CDN JavaScript request headers. */
  sdkHeaders?: Readonly<Record<string, string>>;
  /** Optional application logger; the extracted Authorization value is never logged. */
  logger?: AuthorizationLogger;
  /** Optional fetch implementation for custom networking or offline tests. */
  fetch?: typeof globalThis.fetch;
}

/** Normalized options captured before other callers can install browser globals. */
interface ResolvedAuthorizationOptions {
  /** Whether diagnostic events are enabled. */
  verbose: boolean;
  /** HTML timeout in milliseconds. */
  fetchTimeoutMs: number;
  /** CDN asset timeout in milliseconds. */
  sdkFetchTimeoutMs: number;
  /** HTML request header overrides. */
  htmlHeaders: Readonly<Record<string, string>>;
  /** CDN request header overrides. */
  sdkHeaders: Readonly<Record<string, string>>;
  /** Selected lifecycle logger. */
  logger: AuthorizationLogger;
  /** Native or injected fetch implementation. */
  fetch: typeof globalThis.fetch;
}

/** Validated role for HTML-discovered JavaScript resources. */
type AuthorizationAssetKind = 'entry' | 'chunk';

/** Downloaded source together with origin and integrity metadata. */
interface AuthorizationAsset {
  /** Validated CDN source URL. */
  url: URL;
  /** Complete downloaded JavaScript source. */
  content: string;
  /** Source fingerprint for non-secret diagnostics. */
  hash: string;
}

/** Matched Authorization header and the static module where it was found. */
interface AuthorizationMatch {
  /** Full HTTP Authorization header value including the Bearer prefix. */
  header: string;
  /** CDN location of the embedding static JavaScript module. */
  sourceUrl: URL;
}

/** Current first-party document used for resource discovery. */
const HTML_URL = 'https://x.com/';
/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Upper bound on HTML size (5 MiB). */
const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Upper bound on one CDN JavaScript response (10 MiB). */
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
/** Maximum number of directly imported Entry chunks to inspect. */
const MAX_STATIC_IMPORTS = 32;
/** Total JavaScript budget for Entry and candidate chunks (40 MiB). */
const MAX_TOTAL_JS_BYTES = 40 * 1024 * 1024;
/** Browser-identifying request header used by the HTML and CDN requests. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
/** Chrome client hints corresponding to the current request defaults. */
const CLIENT_HINT = '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"';
/** Native fetch captured before Happy DOM can modify global functions. */
const NATIVE_FETCH = globalThis.fetch.bind(globalThis);
/** Native AbortSignal captured for compatibility with Node's native fetch. */
const NATIVE_ABORT_SIGNAL = globalThis.AbortSignal;

/**
 * Resolve a timeout or reject invalid caller-supplied numbers.
 * @param value - Requested timeout in milliseconds, if provided.
 * @param label - Option label used in validation errors.
 * @returns Positive safe integer timeout.
 */
function validTimeout(value: number | undefined, label: string): number {
  const chosen = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(chosen) || chosen <= 0) throw new RangeError(`${label} 必须是正整数（毫秒）`);
  return chosen;
}

/**
 * Apply defaults and install a non-secret logging boundary.
 * @param options - Public Authorization extraction options.
 * @returns Fully resolved options for a single discovery operation.
 */
function resolveOptions(options: AuthorizationOptions): ResolvedAuthorizationOptions {
  return {
    verbose: options.verbose ?? false,
    fetchTimeoutMs: validTimeout(options.fetchTimeoutMs, 'fetchTimeoutMs'),
    sdkFetchTimeoutMs: validTimeout(options.sdkFetchTimeoutMs, 'sdkFetchTimeoutMs'),
    htmlHeaders: options.htmlHeaders ?? {},
    sdkHeaders: options.sdkHeaders ?? {},
    logger: options.logger ?? {
      info(message, details) { console.info(`[Authorization] ${message}`, details ?? ''); },
      warn(message, details) { console.warn(`[Authorization] ${message}`, details ?? ''); },
      error(message, details) { console.error(`[Authorization] ${message}`, details ?? ''); },
      debug(message, details) { console.debug(`[Authorization:debug] ${message}`, details ?? ''); },
    },
    fetch: options.fetch ?? NATIVE_FETCH,
  };
}

/**
 * Emit detailed metadata only when verbose is enabled.
 * @param options - Normalized discovery options.
 * @param message - Diagnostic title.
 * @param details - Non-secret information about the discovery stage.
 * @returns Nothing.
 */
function debug(options: ResolvedAuthorizationOptions, message: string, details?: Readonly<Record<string, unknown>>): void {
  if (options.verbose) options.logger.debug?.(message, details);
}

/**
 * Compute a fingerprint without exposing a source document or Authorization value.
 * @param source - Text content to hash.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/**
 * Restrict a script URL to the expected first-party CDN scheme and path.
 * @param input - Candidate URL parsed from the HTML or Entry module.
 * @param kind - Expected Entry or hash-named asset role.
 * @returns Validated canonical HTTPS CDN URL.
 */
function validateAssetUrl(input: string | URL, kind: AuthorizationAssetKind): URL {
  const url = new URL(input);
  const pathPattern = kind === 'entry'
    ? /^\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js$/
    : /^\/x-web\/x-web\/assets\/[A-Za-z0-9_-]+\.js$/;
  if (url.protocol !== 'https:' || url.hostname !== 'abs.twimg.com' ||
      url.username || url.password || url.port || url.search || url.hash || !pathPattern.test(url.pathname)) {
    throw new Error(`${kind} 资源 URL 不符合预期的 CDN 路径`);
  }
  return url;
}

/**
 * Construct the standard request headers with caller-supplied overrides.
 * @param options - Request header configuration.
 * @param referer - Parent CDN URL, omitted for the document request.
 * @returns Headers for the HTML or CDN JavaScript request.
 */
function requestHeaders(options: ResolvedAuthorizationOptions, referer?: string): Record<string, string> {
  const common = {
    accept: referer ? '*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'sec-ch-ua': CLIENT_HINT,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'user-agent': USER_AGENT,
  };
  return referer
    ? { ...common, origin: 'https://x.com', referer, 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', ...options.sdkHeaders }
    : { ...common, 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin', 'upgrade-insecure-requests': '1', ...options.htmlHeaders };
}

/**
 * Read a response with a strict byte limit and incremental UTF-8 decoding.
 * @param response - HTTP response with a readable body.
 * @param maxBytes - Maximum response size in bytes.
 * @returns Fully decoded text.
 */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('响应超过大小限制');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('响应超过大小限制');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Fetch the current HTML without executing any downloaded page scripts.
 * @param options - Resolved fetcher, headers and timeouts.
 * @returns Validated non-empty HTML source.
 */
async function fetchHtml(options: ResolvedAuthorizationOptions): Promise<string> {
  const response = await options.fetch(HTML_URL, {
    headers: requestHeaders(options),
    redirect: 'follow',
    signal: NATIVE_ABORT_SIGNAL.timeout(options.fetchTimeoutMs),
  });
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || !['x.com', 'www.x.com'].includes(finalUrl.hostname) ||
      finalUrl.port || finalUrl.username || finalUrl.password) {
    throw new Error('HTML 被重定向到了非预期站点');
  }
  if (!response.ok) throw new Error(`HTML 获取失败：HTTP ${response.status}`);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    throw new Error('HTML Content-Type 不符合预期');
  }
  const html = await readLimitedText(response, MAX_HTML_BYTES);
  if (!html.trim()) throw new Error('HTML 内容为空');
  debug(options, 'HTML 获取完成', { length: html.length, sha256: sha256(html) });
  return html;
}

/**
 * Download a CDN module without permitting cross-origin redirects.
 * @param input - Expected Entry or imported chunk URL.
 * @param kind - Role whose CDN path is validated.
 * @param referer - Parent source URL for request headers.
 * @param options - Resolved network options.
 * @returns Downloaded JavaScript with origin and fingerprint.
 */
async function fetchAsset(input: URL | string, kind: AuthorizationAssetKind, referer: string, options: ResolvedAuthorizationOptions): Promise<AuthorizationAsset> {
  const url = validateAssetUrl(input, kind);
  const response = await options.fetch(url.href, {
    headers: requestHeaders(options, referer),
    redirect: 'manual',
    signal: NATIVE_ABORT_SIGNAL.timeout(options.sdkFetchTimeoutMs),
  });
  const finalUrl = validateAssetUrl(response.url, kind);
  if (finalUrl.href !== url.href || !response.ok || response.redirected) {
    throw new Error(`${kind} 下载失败或重定向：HTTP ${response.status}`);
  }
  if (/text\/html|application\/json/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error(`${kind} 返回了非 JavaScript 内容`);
  }
  const content = await readLimitedText(response, MAX_ASSET_BYTES);
  if (!content.trim()) throw new Error(`${kind} 内容为空`);
  const asset = { url: finalUrl, content, hash: sha256(content) };
  debug(options, 'CDN 资源获取完成', { kind, url: url.href, sha256: asset.hash, size: Buffer.byteLength(content) });
  return asset;
}

/**
 * Extract the only current Entry script from the HTML source.
 * @param html - Current first-party HTML.
 * @returns HTTPS URL of the matching Entry module.
 */
function entryUrlFromHtml(html: string): URL {
  const matches = new Set(Array.from(
    html.matchAll(/https:\/\/abs\.twimg\.com\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js/g),
    match => match[0],
  ));
  if (matches.size !== 1) throw new Error(`HTML Entry 引用数量异常：${matches.size}`);
  return validateAssetUrl([...matches][0]!, 'entry');
}

/**
 * Resolve only direct static Entry imports, ignoring Vite preload string tables.
 * @param entry - Downloaded Entry module.
 * @returns Distinct hash-named JavaScript URLs in import order.
 */
async function staticChunkUrls(entry: AuthorizationAsset): Promise<URL[]> {
  await initModuleLexer();
  const [imports] = parseModule(entry.content);
  const urls = new Map<string, URL>();
  for (const item of imports) {
    if (item.type !== 'static' || item.typeOnly) continue;
    if (!/^\.\/assets\/[A-Za-z0-9_-]+\.js$/.test(item.specifier)) continue;
    const url = validateAssetUrl(new URL(item.specifier, entry.url), 'chunk');
    urls.set(url.href, url);
  }
  if (urls.size === 0 || urls.size > MAX_STATIC_IMPORTS) {
    throw new Error(`Entry 静态依赖数量异常：${urls.size}`);
  }
  return [...urls.values()];
}

/**
 * Extract fixed Authorization Map assignments without executing the source.
 * @param source - Source text of a directly imported Entry chunk.
 * @returns Distinct `Bearer ...` header values assigned to Authorization.
 */
function extractBearerHeaders(source: string): string[] {
  // Match `.set('Authorization', 'Bearer ...')` across quote styles.
  // Capture-group backreferences prevent mismatched quotes or partial values.
  const pattern = /\.\s*set\s*\(\s*(["'`])Authorization\1\s*,\s*(["'`])(Bearer[ \t]+[A-Za-z0-9%._~+\/=\-]+)\2\s*\)/g;
  return [...new Set(Array.from(source.matchAll(pattern), match => match[3]).filter((value): value is string => Boolean(value)))];
}

/**
 * Find the hardcoded Authorization header in the current Entry's static graph.
 *
 * Every direct hashed import is inspected as source text, never imported.
 * Exactly one matching module and one Bearer value must be identified.
 *
 * @param html - Current HTML source providing the Entry reference.
 * @param options - Validated HTTP and logging options.
 * @returns Authorization header and its source module URL.
 */
async function discoverAuthorization(html: string, options: ResolvedAuthorizationOptions): Promise<AuthorizationMatch> {
  const entry = await fetchAsset(entryUrlFromHtml(html), 'entry', HTML_URL, options);
  const candidates = await staticChunkUrls(entry);
  debug(options, 'Entry 直接静态导入解析完成', { candidateCount: candidates.length });

  const matches: AuthorizationMatch[] = [];
  let downloadedBytes = Buffer.byteLength(entry.content);
  for (const url of candidates) {
    const asset = await fetchAsset(url, 'chunk', entry.url.href, options);
    downloadedBytes += Buffer.byteLength(asset.content);
    if (downloadedBytes > MAX_TOTAL_JS_BYTES) throw new Error('Authorization 发现过程下载总量超过限制');
    const headers = extractBearerHeaders(asset.content);
    debug(options, 'Authorization 候选资源检查', { url: asset.url.href, matchingValues: headers.length });
    for (const header of headers) matches.push({ header, sourceUrl: asset.url });
  }
  if (matches.length !== 1) {
    throw new Error(`无法唯一确定 Authorization Token，匹配数量：${matches.length}`);
  }
  return matches[0]!;
}

/**
 * Extract the public-facing Bearer Authorization value from the current X app.
 *
 * This is a static string extraction, not user authentication or an OAuth
 * exchange. The returned value includes `Bearer ` and can be used as the
 * complete HTTP Authorization header value. Percent encoding is preserved.
 * No downloaded JavaScript executes and no token is emitted to logs.
 *
 * @param options - Fetch, timeout and logging configuration.
 * @returns Full Authorization header string (`Bearer ...`).
 * @throws {Error} For missing or ambiguous assignments and network failures.
 * @example
 * ```ts
 * const authorization = await getAuthorizationToken();
 * const headers = { Authorization: authorization };
 * ```
 */
export async function getAuthorizationToken(options: AuthorizationOptions = {}): Promise<string> {
  const settings = resolveOptions(options);
  try {
    settings.logger.info('正在发现 Entry 中的 Authorization Token');
    const html = await fetchHtml(settings);
    const match = await discoverAuthorization(html, settings);
    debug(settings, 'Authorization 来源确认', { sourceUrl: match.sourceUrl.href });
    settings.logger.info('Authorization Token 提取成功');
    return match.header;
  } catch (error) {
    settings.logger.error('Authorization Token 提取失败', {
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
