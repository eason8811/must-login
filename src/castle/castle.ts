import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { CanvasAdapter } from '@happy-dom/node-canvas-adapter';
import { init as initModuleLexer, parse as parseModule } from 'es-module-lexer';

import { fetchCachedCdnText } from '../internal/cdn-cache.js';
import { withExclusiveDom } from '../internal/dom-lock.js';
import { persistSdkBundle } from '../internal/sdk-bundle.js';
import type { SignLogger } from '../sign/sign.js';

/** Application-supplied logger for Castle resource and token lifecycle events. */
export interface CastleLogger extends SignLogger {}

/**
 * Production settings for discovering and executing the currently deployed Castle SDK.
 * Diagnostic execution modes, file traces, and exploratory DOM probes are excluded.
 */
export interface CastleOptions {
  /** Explicitly allow downloaded JavaScript to run within this Node.js process. Default: false. */
  allowRemoteSdkExecution?: boolean;
  /** Include resource URLs, fingerprints, and initialization diagnostics. Default: false. */
  verbose?: boolean;
  /** HTML network request timeout, in milliseconds. Default: 15000. */
  fetchTimeoutMs?: number;
  /** Per-resource CDN network request timeout, in milliseconds. Default: 15000. */
  sdkFetchTimeoutMs?: number;
  /** Maximum time to await `createRequestToken()`, in milliseconds. Default: 15000. */
  tokenTimeoutMs?: number;
  /** Additional HTTP headers for the HTML request. */
  htmlHeaders?: Readonly<Record<string, string>>;
  /** Additional HTTP headers for requests to the X CDN. */
  sdkHeaders?: Readonly<Record<string, string>>;
  /** Root for reusable CDN resources and isolated SDK module graphs. Default: `must-login-castle` under the OS temporary folder. */
  cacheDirectory?: string;
  /** Optional logger. Verbose events are emitted through its `debug` method only. */
  logger?: CastleLogger;
  /** Custom fetch implementation, useful for a network dispatcher or offline testing. */
  fetch?: typeof globalThis.fetch;
}

/** Internal fully resolved options, captured before Happy DOM changes global objects. */
interface ResolvedCastleOptions {
  /** Whether detailed diagnostics are enabled. */
  verbose: boolean;
  /** HTML timeout in milliseconds. */
  fetchTimeoutMs: number;
  /** JavaScript fetch timeout in milliseconds. */
  sdkFetchTimeoutMs: number;
  /** Token generation timeout in milliseconds. */
  tokenTimeoutMs: number;
  /** Extra HTML headers. */
  htmlHeaders: Readonly<Record<string, string>>;
  /** Extra CDN headers. */
  sdkHeaders: Readonly<Record<string, string>>;
  /** Absolute cache directory. */
  cacheDirectory: string;
  /** Structured logger. */
  logger: CastleLogger;
  /** Native or caller-provided fetch implementation. */
  fetch: typeof globalThis.fetch;
}

/** Supported roles for an X CDN JavaScript module. */
type CastleAssetKind = 'entry' | 'chunk' | 'sdk';

/** Downloaded, verified JavaScript with its content fingerprint. */
interface CastleAsset {
  /** Canonical X CDN asset URL. */
  url: URL;
  /** UTF-8 source of the downloaded module. */
  content: string;
  /** SHA-256 of the downloaded source. */
  hash: string;
}

/** Castle module location and its corresponding public key from the same deployment. */
interface CastleDiscovery {
  /** Absolute SDK URL referenced by the Castle loader. */
  sdkUrl: URL;
  /** Referrer URL of the Castle loader module. */
  referer: string;
  /** The public key embedded in the static configuration module. */
  publicKey: string;
}

/** SDK facade exposed by the Castle module or its configure() result. */
interface CastleSdk {
  /**
   * Configure the SDK with its version-matched key.
   * @param options - Object containing the discovered public key.
   * @returns The configured SDK facade, or a non-facade/empty completion value.
   */
  configure(options: { pk: string }): unknown | Promise<unknown>;
  /**
   * Generate a request token in the configured browser environment.
   * @returns A token string if the remote SDK completes successfully.
   */
  createRequestToken(): unknown | Promise<unknown>;
}

/** Happy DOM window needed to set resource loading and canvas settings. */
interface CastleWindow {
  /** Happy DOM internal browser configuration. */
  happyDOM: { settings: Record<string, unknown> };
}

/** First-party HTML location for the current resource manifest. */
const HTML_URL = 'https://x.com/';
/** Default network and SDK timeout (milliseconds). */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Maximum accepted HTML body (5 MiB). */
const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Maximum accepted CDN script body (10 MiB). */
const MAX_JS_BYTES = 10 * 1024 * 1024;
/** Maximum number of imports to inspect at each discovery level. */
const MAX_IMPORT_CANDIDATES = 64;
/** Browser-like user agent for the latest X HTML and CDN. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
/** Browser client hints used by the HTML request. */
const CLIENT_HINT = '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"';
/** Native fetch retained before registration replaces global browser APIs. */
const NATIVE_FETCH = globalThis.fetch.bind(globalThis);
/** Native AbortSignal retained for use by Node's fetch after DOM registration. */
const NATIVE_ABORT_SIGNAL = globalThis.AbortSignal;
/** Ensure importing the SDK in another DOM session evaluates its module again. */
let moduleImportSequence = 0;

/**
 * Validate a caller-controlled timeout or supply the standard timeout.
 * @param value - Timeout in milliseconds, if provided.
 * @param name - Option name for error reporting.
 * @returns Validated positive integer timeout.
 */
function validTimeout(value: number | undefined, name: string): number {
  const chosen = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(chosen) || chosen <= 0) throw new RangeError(`${name} 必须是正整数（毫秒）`);
  return chosen;
}

/**
 * Apply defaults and choose a logger for one Castle invocation.
 * @param options - Caller-provided Castle options.
 * @returns Resolved immutable-by-convention runtime settings.
 */
function resolveOptions(options: CastleOptions): ResolvedCastleOptions {
  return {
    verbose: options.verbose ?? false,
    fetchTimeoutMs: validTimeout(options.fetchTimeoutMs, 'fetchTimeoutMs'),
    sdkFetchTimeoutMs: validTimeout(options.sdkFetchTimeoutMs, 'sdkFetchTimeoutMs'),
    tokenTimeoutMs: validTimeout(options.tokenTimeoutMs, 'tokenTimeoutMs'),
    htmlHeaders: options.htmlHeaders ?? {},
    sdkHeaders: options.sdkHeaders ?? {},
    cacheDirectory: resolve(options.cacheDirectory ?? resolve(tmpdir(), 'must-login-castle')),
    logger: options.logger ?? {
      info(message, details) { console.info(`[Castle] ${message}`, details ?? ''); },
      warn(message, details) { console.warn(`[Castle] ${message}`, details ?? ''); },
      error(message, details) { console.error(`[Castle] ${message}`, details ?? ''); },
      debug(message, details) { console.debug(`[Castle:debug] ${message}`, details ?? ''); },
    },
    fetch: options.fetch ?? NATIVE_FETCH,
  };
}

/**
 * Emit diagnostic metadata only when verbose mode is active.
 * @param options - Resolved runtime settings.
 * @param message - Diagnostic event name.
 * @param details - Optional non-sensitive event metadata.
 * @returns Nothing.
 */
function debug(options: ResolvedCastleOptions, message: string, details?: Readonly<Record<string, unknown>>): void {
  if (options.verbose) options.logger.debug?.(message, details);
}

/**
 * Hash downloaded source for integrity checks and cache filenames.
 * @param source - Downloaded source or existing file bytes.
 * @returns Lowercase SHA-256 hex digest.
 */
function sha256(source: string | Buffer): string {
  return createHash('sha256').update(source).digest('hex');
}

/**
 * Restrict all discovered JavaScript URLs to X's known immutable CDN paths.
 * @param input - URL or URL string from the HTML/module graph.
 * @param kind - Whether the source is an Entry, hashed chunk, or SDK.
 * @returns Validated canonical URL.
 */
function validateAssetUrl(input: URL | string, kind: CastleAssetKind): URL {
  const url = new URL(input);
  const path = kind === 'entry'
    ? /^\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js$/
    : /^\/x-web\/x-web\/assets\/[A-Za-z0-9_-]+\.js$/;
  if (url.protocol !== 'https:' || url.hostname !== 'abs.twimg.com' ||
      url.username || url.password || url.port || url.search || url.hash || !path.test(url.pathname)) {
    throw new Error(`${kind} 资源 URL 不符合预期的 CDN 路径`);
  }
  return url;
}

/**
 * Build HTTP headers appropriate for an HTML or CDN resource.
 * @param options - Runtime header overrides.
 * @param referer - Optional parent URL; absent for the initial HTML request.
 * @returns Header map passed to fetch.
 */
function requestHeaders(options: ResolvedCastleOptions, referer?: string): Record<string, string> {
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
 * Decode an HTTP response incrementally with a strict byte cap.
 * @param response - Fetch response to inspect.
 * @param maxBytes - Maximum allowed UTF-8 source bytes.
 * @returns Complete response text.
 */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('HTTP 响应超过大小限制');
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
      if (total > maxBytes) throw new Error('HTTP 响应超过大小限制');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Fetch the current X homepage HTML that defines the matching Entry script.
 * @param options - Network implementation and HTML timeout.
 * @returns Validated HTML source.
 */
async function fetchHtml(options: ResolvedCastleOptions): Promise<string> {
  const response = await options.fetch(HTML_URL, {
    headers: requestHeaders(options),
    redirect: 'follow',
    signal: NATIVE_ABORT_SIGNAL.timeout(options.fetchTimeoutMs),
  });
  const url = new URL(response.url);
  if (url.protocol !== 'https:' || !['x.com', 'www.x.com'].includes(url.hostname) || url.port || url.username || url.password) {
    throw new Error('HTML 响应被重定向到非预期站点');
  }
  if (!response.ok) throw new Error(`HTML 获取失败：HTTP ${response.status}`);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    throw new Error('HTML Content-Type 不符合预期');
  }
  const html = await readLimitedText(response, MAX_HTML_BYTES);
  if (!html.trim()) throw new Error('HTML 内容为空');
  debug(options, 'HTML 获取成功', { length: html.length, sha256: sha256(html) });
  return html;
}

/**
 * Load an immutable CDN JavaScript file from cache or download it.
 * @param input - Previously discovered asset URL.
 * @param kind - Expected asset kind.
 * @param referer - Parent resource URL for the fetch headers.
 * @param options - Fetcher, timeout, and diagnostic settings.
 * @returns Validated content and SHA-256 fingerprint.
 */
async function fetchAsset(input: URL | string, kind: CastleAssetKind, referer: string, options: ResolvedCastleOptions): Promise<CastleAsset> {
  const url = validateAssetUrl(input, kind);
  const asset = await fetchCachedCdnText({
    url,
    cacheDirectory: options.cacheDirectory,
    maxBytes: MAX_JS_BYTES,
    debug: (message, details) => debug(options, message, details),
    fetchRemote: async () => {
      const response = await options.fetch(url.href, {
        headers: requestHeaders(options, referer),
        redirect: 'manual',
        signal: NATIVE_ABORT_SIGNAL.timeout(options.sdkFetchTimeoutMs),
      });
      const finalUrl = validateAssetUrl(response.url, kind);
      if (finalUrl.href !== url.href || !response.ok || response.redirected) {
        throw new Error(`${kind} CDN 下载失败或发生重定向：HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (/text\/html|application\/json/i.test(contentType)) throw new Error(`${kind} 返回非 JS 数据`);
      return readLimitedText(response, MAX_JS_BYTES);
    },
  });
  debug(options, 'CDN 资源获取完成', { kind, url: url.href, sha256: asset.hash, size: asset.size, cacheHit: asset.fromCache });
  return { url, content: asset.content, hash: asset.hash };
}

/**
 * Extract direct static ESM imports, excluding Vite's preload map string table.
 * @param source - JavaScript module source.
 * @param baseUrl - URL against which relative specifiers are resolved.
 * @param isEntry - Whether imports use `./assets/name.js` rather than `./name.js`.
 * @returns Distinct directly imported X CDN chunk URLs.
 */
async function staticChunkUrls(source: string, baseUrl: URL, isEntry: boolean): Promise<URL[]> {
  await initModuleLexer();
  const [imports] = parseModule(source);
  const chunks = new Map<string, URL>();
  const pattern = isEntry
    ? /^\.\/assets\/[A-Za-z0-9_-]+\.js$/
    : /^\.\/(?:assets\/)?[A-Za-z0-9_-]+\.js$/;
  for (const item of imports) {
    if (item.type !== 'static' || item.typeOnly || !pattern.test(item.specifier)) continue;
    const url = validateAssetUrl(new URL(item.specifier, baseUrl), 'chunk');
    chunks.set(url.href, url);
  }
  if (chunks.size === 0 || chunks.size > MAX_IMPORT_CANDIDATES) {
    throw new Error(`静态导入候选数量异常：${chunks.size}`);
  }
  return [...chunks.values()];
}

/**
 * Identify the Castle loader from its stable feature flag, key lookup and configure call.
 * @param source - Candidate Startup/dispatcher module source.
 * @returns Whether this module includes the observed Castle initialization chain.
 */
function looksLikeCastleStartup(source: string): boolean {
  return /responsive_web_castle_sdk_enabled/.test(source) &&
    /getStringValue\s*\(\s*["'`]responsive_web_castle_public_key["'`]\s*\)/.test(source) &&
    /\.configure\s*\(\s*\{\s*pk\s*:/.test(source);
}

/**
 * Extract the unique dynamic import inside the Castle loader's key/configure chain.
 * @param source - Identified Castle Startup module.
 * @returns Castle SDK relative JavaScript specifier.
 */
function castleSdkSpecifier(source: string): string {
  const anchors = [...source.matchAll(/getStringValue\s*\(\s*["'`]responsive_web_castle_public_key["'`]\s*\)/g)];
  const candidates = new Set<string>();
  for (const anchor of anchors) {
    const following = source.slice(anchor.index, anchor.index + 2048);
    const configureIndex = following.search(/\.configure\s*\(\s*\{\s*pk\s*:/);
    if (configureIndex < 0) continue;
    const chain = following.slice(0, configureIndex);
    for (const match of chain.matchAll(/\bimport\s*\(\s*["'`](\.\/[A-Za-z0-9_-]+\.js)["'`]\s*\)/g)) {
      if (match[1]) candidates.add(match[1]);
    }
  }
  if (candidates.size !== 1) throw new Error(`无法唯一匹配 Castle SDK 动态导入：${candidates.size}`);
  return [...candidates][0]!;
}

/**
 * Find the stable `responsive_web_castle_public_key` literal in a config module.
 * @param source - JavaScript source of a statically imported dependency.
 * @returns Distinct public key values found in the module.
 */
function castlePublicKeys(source: string): string[] {
  const pattern = /(?:^|[,{])\s*(?:responsive_web_castle_public_key|["'`]responsive_web_castle_public_key["'`])\s*:\s*(["'`])(pk_[A-Za-z0-9_-]+)\1/g;
  return [...new Set(Array.from(source.matchAll(pattern), match => match[2]).filter((key): key is string => Boolean(key)))];
}

/**
 * Discover the Castle SDK and its public key through the current HTML module graph.
 *
 * Discovery uses semantic code/configuration markers, never hard-coded hash names:
 * HTML -> Entry -> Castle loader -> dynamic SDK import, plus loader static
 * imports -> public key configuration. None of these modules are executed here.
 *
 * @param html - Current first-party HTML source.
 * @param options - Network access and diagnostic options.
 * @returns Version-matched Castle SDK URL and public key.
 */
async function discoverCastle(html: string, options: ResolvedCastleOptions): Promise<CastleDiscovery> {
  const entryUrls = [...new Set(Array.from(html.matchAll(/https:\/\/abs\.twimg\.com\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js/g), match => match[0]))];
  if (entryUrls.length !== 1) throw new Error(`HTML Entry 引用数量异常：${entryUrls.length}`);
  const entry = await fetchAsset(entryUrls[0]!, 'entry', HTML_URL, options);
  const startupUrls = await staticChunkUrls(entry.content, entry.url, true);
  debug(options, 'Entry 静态导入解析完成', { candidateCount: startupUrls.length });
  const startupMatches: CastleAsset[] = [];
  for (const url of startupUrls) {
    const asset = await fetchAsset(url, 'chunk', entry.url.href, options);
    if (looksLikeCastleStartup(asset.content)) startupMatches.push(asset);
  }
  if (startupMatches.length !== 1) throw new Error(`无法唯一匹配 Castle Startup：${startupMatches.length}`);
  const startup = startupMatches[0]!;
  const specifier = castleSdkSpecifier(startup.content);
  const sdkUrl = validateAssetUrl(new URL(specifier, startup.url), 'sdk');
  const configUrls = await staticChunkUrls(startup.content, startup.url, false);
  const keys = new Set<string>();
  for (const url of configUrls) {
    const asset = await fetchAsset(url, 'chunk', startup.url.href, options);
    for (const key of castlePublicKeys(asset.content)) keys.add(key);
  }
  if (keys.size !== 1) throw new Error(`无法唯一匹配 Castle 公钥：${keys.size}`);
  debug(options, 'Castle SDK 与公钥发现成功', {
    startupUrl: startup.url.href,
    sdkUrl: sdkUrl.href,
    configChunksInspected: configUrls.length,
    publicKeyFound: true,
  });
  return { sdkUrl, referer: startup.url.href, publicKey: [...keys][0]! };
}

/**
 * Disable external scripts, images, CSS and iframe loading in Happy DOM.
 * @param window - Registered browser window.
 * @returns Nothing.
 */
function disableResourceLoading(window: CastleWindow): void {
  const settings = window.happyDOM?.settings;
  if (!settings) throw new Error('Happy DOM settings 不可用');
  const overrides: Record<string, boolean> = {
    enableJavaScriptEvaluation: false,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    enableCSSFileLoading: false,
    disableCSSFileLoading: true,
    enableImageFileLoading: false,
    enableIframePageLoading: true,
    disableIframePageLoading: false,
    handleDisabledFileLoadingAsSuccess: true,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (name in settings) settings[name] = value;
  }
}

/**
 * Import and validate the remote Castle SDK after Happy DOM has been registered.
 * @param filePath - Local entry file of the complete Castle SDK module graph.
 * @returns SDK default export with configure and createRequestToken methods.
 */
async function importCastleSdk(filePath: string): Promise<CastleSdk> {
  const url = pathToFileURL(filePath);
  url.searchParams.set('mustLoginRun', String(++moduleImportSequence));
  const module = await import(url.href) as { default?: Partial<CastleSdk> };
  const sdk = module.default;
  if (!sdk || typeof sdk.configure !== 'function' || typeof sdk.createRequestToken !== 'function') {
    throw new TypeError('Castle SDK 缺少 configure 或 createRequestToken 方法');
  }
  return sdk as CastleSdk;
}

/**
 * Limit how long to await SDK token generation (without cancelling SDK work).
 * @typeParam T - Promise result type.
 * @param task - Function invoking the SDK.
 * @param timeoutMs - Maximum elapsed time in milliseconds.
 * @returns Resolved SDK result when completed before timeout.
 */
async function withTimeout<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Castle Token 生成超过 ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Generate a Castle request token with the latest SDK and its matching public key.
 *
 * This function first fetches HTML, Entry, the Castle loader, the key-containing
 * static configuration dependency and the Castle SDK. It then creates a fresh
 * Happy DOM environment, configures the SDK with the discovered key, and calls
 * `createRequestToken()`. The returned token and public key are never logged.
 * Node-global browser environments are serialized with Sign SDK calls.
 *
 * @param options - Production network, logging, timeout and execution settings.
 * @returns Non-empty Castle token returned by the SDK.
 * @throws {Error} If execution is not explicitly allowed, resources cannot be
 * matched uniquely, or the remote SDK fails to generate a token.
 * @example
 * ```ts
 * const token = await generateCastleToken({
 *   allowRemoteSdkExecution: true,
 *   verbose: false,
 * });
 * ```
 */
export async function generateCastleToken(options: CastleOptions = {}): Promise<string> {
  if (!options.allowRemoteSdkExecution) {
    throw new Error('执行远程 Castle SDK 需要显式设置 allowRemoteSdkExecution: true');
  }
  const settings = resolveOptions(options);
  return withExclusiveDom(async () => {
    let registered = false;
    try {
      settings.logger.info('正在发现当前 HTML、Castle SDK 与公钥');
      const html = await fetchHtml(settings);
      const { sdkUrl, referer, publicKey } = await discoverCastle(html, settings);
      const asset = await fetchAsset(sdkUrl, 'sdk', referer, settings);
      const sdkPath = await persistSdkBundle(asset, {
        cacheDirectory: settings.cacheDirectory,
        fetchDependency: (url, referer) => fetchAsset(url, 'chunk', referer, settings),
        debug: (message, details) => debug(settings, `Castle ${message}`, details),
      });
      settings.logger.info('Castle SDK 及依赖准备完成', { sha256: asset.hash.slice(0, 12) });

      // All HTTP work finishes before Happy DOM overrides Node global classes.
      GlobalRegistrator.register({ url: HTML_URL, width: 1920, height: 1080 });
      registered = true;
      const window = globalThis.window as unknown as CastleWindow;
      window.happyDOM.settings.canvasAdapter = new CanvasAdapter();
      disableResourceLoading(window);
      globalThis.document.open();
      globalThis.document.write(html);
      globalThis.document.close();

      const sdk = await importCastleSdk(sdkPath);
      const configured = await sdk.configure({ pk: publicKey });
      const configuredSdk = configured && typeof (configured as Partial<CastleSdk>).createRequestToken === 'function'
        ? configured as CastleSdk
        : sdk;
      debug(settings, 'Castle SDK 配置完成', { returnedConfiguredInstance: configuredSdk !== sdk });
      const result = await withTimeout(async () => configuredSdk.createRequestToken(), settings.tokenTimeoutMs);
      if (typeof result !== 'string' || !result) throw new TypeError('Castle SDK 返回了空值或非字符串 Token');
      settings.logger.info('Castle Token 生成成功', { length: result.length });
      return result;
    } catch (error) {
      settings.logger.error('Castle Token 生成失败', { reason: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (registered) await GlobalRegistrator.unregister();
    }
  });
}
