import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { CanvasAdapter } from '@happy-dom/node-canvas-adapter';
import { init as initModuleLexer, parse as parseModule } from 'es-module-lexer';

import { withExclusiveDom } from '../internal/dom-lock.js';
import { installAnimationComputedStyleBridge, type AnimationWindow } from './animation.js';

/** Log severity exposed to consumers of the signing tool. */
export type SignLogLevel = 'info' | 'warn' | 'error' | 'debug';

/** Structured event details; never includes the signature or downloaded HTML. */
export type SignLogDetails = Readonly<Record<string, unknown>>;

/** Pluggable logging interface for integrating with an application's logger. */
export interface SignLogger {
  /**
   * Record an important lifecycle event.
   * @param message - Event title.
   * @param details - Optional non-sensitive structured context.
   * @returns Nothing.
   */
  info(message: string, details?: SignLogDetails): void;
  /**
   * Record an unusual but recoverable condition.
   * @param message - Warning title.
   * @param details - Optional non-sensitive structured context.
   * @returns Nothing.
   */
  warn(message: string, details?: SignLogDetails): void;
  /**
   * Record an operation failure.
   * @param message - Error title.
   * @param details - Optional non-sensitive structured context.
   * @returns Nothing.
   */
  error(message: string, details?: SignLogDetails): void;
  /**
   * Record detailed diagnostics when verbose logging is enabled.
   * @param message - Diagnostic title.
   * @param details - Optional non-sensitive structured context.
   * @returns Nothing.
   */
  debug?(message: string, details?: SignLogDetails): void;
}

/**
 * Options controlling how the current HTML and its paired Sign SDK are loaded.
 *
 * Exploration-only modes, snapshots and DOM probes are intentionally omitted.
 * The HTML endpoint, SDK discovery chain and animation bridge are internal.
 */
export interface SignOptions {
  /**
   * Explicitly permit execution of JavaScript downloaded from the X CDN.
   * Defaults to `false`; enabling it executes third-party code in this process.
   */
  allowRemoteSdkExecution?: boolean;
  /** Log resource URLs, hashes, DOM checks and animation diagnostics. Default: false. */
  verbose?: boolean;
  /** Timeout for fetching the HTML document, in milliseconds. Default: 15000. */
  fetchTimeoutMs?: number;
  /** Timeout for fetching each CDN JavaScript asset, in milliseconds. Default: 15000. */
  sdkFetchTimeoutMs?: number;
  /** Timeout for the signer function to resolve, in milliseconds. Default: 15000. */
  signTimeoutMs?: number;
  /** Extra headers for the HTML request (overrides the built-in headers). */
  htmlHeaders?: Readonly<Record<string, string>>;
  /** Extra headers for JavaScript CDN requests (overrides the built-in headers). */
  sdkHeaders?: Readonly<Record<string, string>>;
  /**
   * Directory used for content-addressed SDK module snapshots.
   * Default: a private `must-login-sign` directory under the OS temp directory.
   */
  cacheDirectory?: string;
  /** Override console output with an application logger. */
  logger?: SignLogger;
  /** Fetch implementation, useful for custom network dispatchers and offline tests. */
  fetch?: typeof globalThis.fetch;
}

/** The normalized, immutable settings used during one signing attempt. */
interface ResolvedSignOptions {
  /** Whether detailed diagnostic logging is enabled. */
  verbose: boolean;
  /** HTML fetch timeout. */
  fetchTimeoutMs: number;
  /** CDN fetch timeout. */
  sdkFetchTimeoutMs: number;
  /** Signature generation timeout. */
  signTimeoutMs: number;
  /** HTML request header overrides. */
  htmlHeaders: Readonly<Record<string, string>>;
  /** SDK request header overrides. */
  sdkHeaders: Readonly<Record<string, string>>;
  /** Absolute snapshot cache path. */
  cacheDirectory: string;
  /** Logger selected for this call. */
  logger: SignLogger;
  /** Network implementation captured before browser globals are registered. */
  fetch: typeof globalThis.fetch;
}

/** The permitted CDN asset roles in the discovery chain. */
type AssetKind = 'entry' | 'startup' | 'sdk';

/** Validated downloaded JavaScript source and its content fingerprint. */
interface CdnAsset {
  /** Validated final asset URL. */
  url: URL;
  /** JavaScript source as UTF-8 text. */
  content: string;
  /** Number of UTF-8 source bytes. */
  size: number;
  /** Full SHA-256 hash of the source. */
  hash: string;
}

/** SDK URL and the referrer selected from one resource chain. */
interface SdkDiscovery {
  /** URL of the SDK referenced by startup-dynamic. */
  sdkUrl: URL;
  /** URL of the corresponding startup-dynamic asset. */
  referer: string;
}

/** Default executable signature function returned by the SDK initializer. */
type Signer = (input: string, method: string) => Promise<unknown> | unknown;

/** Internal browser window with Happy DOM configuration settings. */
interface SignBrowserWindow extends AnimationWindow {
  /** Happy DOM resource-loading and Canvas settings. */
  happyDOM: { settings: Record<string, unknown> };
}

/** Default HTML URL used to discover the currently deployed SDK. */
const HTML_URL = 'https://x.com/';
/** Stable SVG selector used to check that the SDK's HTML prerequisites exist. */
const SVG_SELECTOR = 'svg[id^="loading-x-anim-"]';
/** Maximum accepted HTML response size (5 MiB). */
const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Maximum accepted JavaScript asset size (10 MiB). */
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
/** Default timeout for network requests and signing (milliseconds). */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Browser header shared between HTML and CDN requests. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
/** Chrome client-hint header retained from the validated runtime environment. */
const CLIENT_HINT = '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"';
/** Hostnames known to call the Sign SDK in the observed request flow. */
const SIGN_HOSTNAMES = new Set([
  'api.twitter.com', 'upload.twitter.com', 'caps.twitter.com',
  'api.x.com', 'upload.x.com', 'caps.x.com', 'jf.x.com',
]);
/** Supported first-party path prefixes for same-origin API requests. */
const SIGN_URL_PREFIXES = [
  'https://twitter.com/i/api', 'https://x.com/i/api', 'https://x.com/i/jfapi',
];
/** Native fetch captured before Happy DOM can replace global constructors. */
const NATIVE_FETCH = globalThis.fetch.bind(globalThis);
/** Native AbortSignal constructor captured before Happy DOM registration. */
const NATIVE_ABORT_SIGNAL = globalThis.AbortSignal;

/** Import cache-busting counter, ensuring a new environment for each SDK run. */
let importSequence = 0;

/**
 * Validate a positive timeout supplied by the caller.
 * @param value - User-supplied timeout or undefined to apply the default.
 * @param label - Parameter name included in validation errors.
 * @returns Validated timeout in milliseconds.
 * @throws {RangeError} When the timeout is not a positive safe integer.
 */
function positiveTimeout(value: number | undefined, label: string): number {
  const chosen = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(chosen) || chosen <= 0) {
    throw new RangeError(`${label} 必须是正整数（毫秒）`);
  }
  return chosen;
}

/**
 * Resolve user options into defaults and establish a logging boundary.
 * @param options - Partial user-provided signing configuration.
 * @returns Fully resolved runtime options.
 */
function resolveOptions(options: SignOptions): ResolvedSignOptions {
  return {
    verbose: options.verbose ?? false,
    fetchTimeoutMs: positiveTimeout(options.fetchTimeoutMs, 'fetchTimeoutMs'),
    sdkFetchTimeoutMs: positiveTimeout(options.sdkFetchTimeoutMs, 'sdkFetchTimeoutMs'),
    signTimeoutMs: positiveTimeout(options.signTimeoutMs, 'signTimeoutMs'),
    htmlHeaders: options.htmlHeaders ?? {},
    sdkHeaders: options.sdkHeaders ?? {},
    cacheDirectory: resolve(options.cacheDirectory ?? resolve(tmpdir(), 'must-login-sign')),
    logger: options.logger ?? {
      info(message, details) { console.info(`[Sign] ${message}`, details ?? ''); },
      warn(message, details) { console.warn(`[Sign] ${message}`, details ?? ''); },
      error(message, details) { console.error(`[Sign] ${message}`, details ?? ''); },
      debug(message, details) { console.debug(`[Sign:debug] ${message}`, details ?? ''); },
    },
    fetch: options.fetch ?? NATIVE_FETCH,
  };
}

/**
 * Emit detailed metadata only when verbose mode is enabled.
 * @param options - Resolved runtime configuration.
 * @param message - Diagnostic event title.
 * @param details - Optional structured, non-sensitive metadata.
 * @returns Nothing.
 */
function debug(options: ResolvedSignOptions, message: string, details?: SignLogDetails): void {
  if (options.verbose) options.logger.debug?.(message, details);
}

/**
 * Compute a content fingerprint for cache names and diagnostic logs.
 * @param content - Source text or downloaded bytes.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Validate an X CDN URL against the expected HTTPS file naming convention.
 * @param value - Untrusted URL or already parsed URL.
 * @param kind - Expected entry, startup, or SDK resource type.
 * @returns Canonical URL after all host/path checks.
 * @throws {Error} When the URL points outside the approved CDN path.
 */
function validateCdnAssetUrl(value: string | URL, kind: AssetKind): URL {
  const url = new URL(value);
  // Startup and Sign SDK assets no longer have semantic filename prefixes.
  // Their roles must be established by inspecting the module graph/content.
  const hashedAssetPath = /^\/x-web\/x-web\/assets\/[A-Za-z0-9_-]+\.js$/;
  const paths: Record<AssetKind, RegExp> = {
    entry: /^\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js$/,
    startup: hashedAssetPath,
    sdk: hashedAssetPath,
  };
  if (url.protocol !== 'https:' || url.hostname !== 'abs.twimg.com' ||
      url.username || url.password || url.port || url.search || url.hash ||
      !paths[kind].test(url.pathname)) {
    throw new Error(`${kind} 资源地址不符合受限 CDN 路径规则`);
  }
  return url;
}

/**
 * Extract exactly one distinct URL or specifier from HTML/JavaScript text.
 * @param source - Text containing module references.
 * @param pattern - Global regular expression whose first capture is the reference.
 * @param label - Description included in ambiguity errors.
 * @returns The sole distinct reference string.
 * @throws {Error} When no candidate or more than one candidate exists.
 */
function extractUniqueReference(source: string, pattern: RegExp, label: string): string {
  const candidates = [...new Set(Array.from(source.matchAll(pattern), match => match[1] ?? match[0]))];
  if (candidates.length !== 1 || !candidates[0]) {
    throw new Error(`${label} 引用数量不符合预期：${candidates.length}（必须恰好为 1）`);
  }
  return candidates[0];
}

/**
 * Construct headers used to fetch the current HTML document.
 * @param options - Resolved options containing optional header overrides.
 * @returns Header names mapped to their HTTP values.
 */
function htmlRequestHeaders(options: ResolvedSignOptions): Record<string, string> {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'sec-ch-ua': CLIENT_HINT,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'upgrade-insecure-requests': '1',
    'user-agent': USER_AGENT,
    ...options.htmlHeaders,
  };
}

/**
 * Construct headers for CDN JavaScript requests.
 * @param options - Resolved options containing optional header overrides.
 * @param referer - URL of the parent module in the discovery chain.
 * @returns Header names mapped to their HTTP values.
 */
function sdkRequestHeaders(options: ResolvedSignOptions, referer: string): Record<string, string> {
  return {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    origin: 'https://x.com',
    pragma: 'no-cache',
    referer,
    'sec-ch-ua': CLIENT_HINT,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'script',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': USER_AGENT,
    ...options.sdkHeaders,
  };
}

/**
 * Read response bytes incrementally, enforcing a size limit.
 * @param response - Fetch response whose body is streamed as UTF-8.
 * @param maxBytes - Maximum permitted response size.
 * @returns Fully decoded response text.
 * @throws {Error} When the response exceeds the size limit.
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
 * Download the current X HTML before installing browser globals.
 * @param options - Fetch implementation, headers, and timeout.
 * @returns Validated non-empty HTML source.
 * @throws {Error} For HTTP errors, unsafe redirects, or invalid content.
 */
async function fetchHtml(options: ResolvedSignOptions): Promise<string> {
  const response = await options.fetch(HTML_URL, {
    headers: htmlRequestHeaders(options),
    redirect: 'follow',
    signal: NATIVE_ABORT_SIGNAL.timeout(options.fetchTimeoutMs),
  });
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || !['x.com', 'www.x.com'].includes(finalUrl.hostname)) {
    throw new Error('HTML 响应重定向到了非预期站点');
  }
  if (!response.ok) throw new Error(`HTML 获取失败：HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) {
    throw new Error(`HTML Content-Type 不匹配：${contentType}`);
  }
  const html = await readLimitedText(response, MAX_HTML_BYTES);
  if (!html.trim()) throw new Error('HTML 内容为空');
  debug(options, 'HTML 获取完成', { length: html.length, sha256: sha256(html), finalUrl: finalUrl.href });
  return html;
}

/**
 * Download a validated CDN asset without following redirects.
 * @param urlInput - URL from the validated discovery chain.
 * @param kind - Expected asset role in the chain.
 * @param referer - Parent module URL for the request header.
 * @param options - Network implementation and download limits.
 * @returns Downloaded asset with SHA-256 metadata.
 * @throws {Error} For invalid URLs, HTTP failures, or oversized content.
 */
async function fetchAsset(
  urlInput: string | URL,
  kind: AssetKind,
  referer: string,
  options: ResolvedSignOptions,
): Promise<CdnAsset> {
  const requested = validateCdnAssetUrl(urlInput, kind);
  const response = await options.fetch(requested.href, {
    headers: sdkRequestHeaders(options, referer),
    redirect: 'manual',
    signal: NATIVE_ABORT_SIGNAL.timeout(options.sdkFetchTimeoutMs),
  });
  const finalUrl = validateCdnAssetUrl(response.url, kind);
  if (!response.ok || response.redirected) throw new Error(`${kind} 下载失败：HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (/text\/html|application\/json/i.test(contentType)) {
    throw new Error(`${kind} 返回了非 JavaScript 内容（${contentType}）`);
  }
  const content = await readLimitedText(response, MAX_ASSET_BYTES);
  if (!content.trim()) throw new Error(`${kind} 内容为空`);
  const asset: CdnAsset = { url: finalUrl, content, size: Buffer.byteLength(content), hash: sha256(content) };
  debug(options, 'CDN 资源获取完成', { kind, url: finalUrl.href, size: asset.size, sha256: asset.hash });
  return asset;
}

/** Maximum number of direct Entry imports eligible for Startup inspection. */
const MAX_STARTUP_CANDIDATES = 32;

/**
 * Extract hash-named JavaScript files referenced by static ESM imports.
 *
 * The lexer ignores filename strings used only by Vite's preload dependency
 * table, which are not necessarily direct imports of the Entry module.
 *
 * @param source - JavaScript source of the Entry module.
 * @param baseUrl - Absolute URL of the Entry module.
 * @returns Distinct CDN URLs in import order.
 * @throws {Error} If a referenced CDN asset violates the allowed URL rules.
 */
async function extractStaticChunkUrls(source: string, baseUrl: URL): Promise<URL[]> {
  await initModuleLexer();
  const [imports] = parseModule(source);
  const urls = new Map<string, URL>();

  for (const item of imports) {
    if (item.type !== 'static' || item.typeOnly) continue;
    const specifier = item.specifier;
    if (!/^\.\/assets\/[A-Za-z0-9_-]+\.js$/.test(specifier)) continue;
    const url = validateCdnAssetUrl(new URL(specifier, baseUrl), 'startup');
    urls.set(url.href, url);
  }
  return [...urls.values()];
}

/**
 * Identify a candidate Sign callsite using observed JF request constants.
 *
 * This is a conservative content fingerprint, not proof that a module is the
 * signature dispatcher; ambiguous candidates are rejected by discoverSdk().
 *
 * @param source - JavaScript module source to inspect without executing.
 * @returns True when all three observed signing branch markers are present.
 */
function looksLikeSignStartup(source: string): boolean {
  return (
    /["'`]jf\.x\.com["'`]/.test(source) &&
    /["'`]\.jf\.x\.com["'`]/.test(source) &&
    /["'`]PATCH["'`]/.test(source)
  );
}

/**
 * Follow the current HTML Entry into its directly imported hashed JS chunks.
 *
 * Identify the unique Sign dispatcher by observed JF/PATCH branch markers,
 * then extract the literal dynamic import whose resolved default export is
 * invoked as the signer factory. No downloaded Entry/Startup source is executed.
 *
 * @param html - Current X HTML document text.
 * @param options - Network and diagnostics settings for fetching candidates.
 * @returns SDK URL and matching startup module referrer.
 * @throws {Error} When there are no candidates, too many candidates, or
 * the content cannot uniquely identify the Startup/SDK references.
 */
async function discoverSdk(html: string, options: ResolvedSignOptions): Promise<SdkDiscovery> {
  const entryUrl = extractUniqueReference(
    html,
    /https:\/\/abs\.twimg\.com\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js/g,
    'HTML 中的 entry-client-logged-out',
  );
  const entry = await fetchAsset(entryUrl, 'entry', HTML_URL, options);
  const candidates = await extractStaticChunkUrls(entry.content, entry.url);

  debug(options, 'Entry 静态依赖解析完成', { count: candidates.length });
  if (candidates.length === 0 || candidates.length > MAX_STARTUP_CANDIDATES) {
    throw new Error(`Entry 静态依赖数量异常：${candidates.length}`);
  }

  const matches: CdnAsset[] = [];
  for (const candidate of candidates) {
    const asset = await fetchAsset(candidate, 'startup', entry.url.href, options);
    const matched = looksLikeSignStartup(asset.content);
    debug(options, 'Startup 候选分析', { url: asset.url.href, matched });
    if (matched) matches.push(asset);
  }

  if (matches.length !== 1) {
    throw new Error(`无法唯一确定签名调用模块，候选数量：${matches.length}`);
  }

  const startup = matches[0]!;
  const sdkSpecifier = extractUniqueReference(
    startup.content,
    /\bimport\s*\(\s*["'`](\.\/[A-Za-z0-9_-]+\.js)["'`]\s*\)\s*\.then\s*\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\2\.default\s*\(\s*\)\s*\)/g,
    '签名调用模块中的 SDK 动态导入',
  );
  const sdkUrl = validateCdnAssetUrl(new URL(sdkSpecifier, startup.url), 'sdk');

  debug(options, 'SDK 引用链匹配成功', {
    entryUrl: entry.url.href,
    startupUrl: startup.url.href,
    sdkUrl: sdkUrl.href,
  });
  return { sdkUrl, referer: startup.url.href };
}

/**
 * Persist SDK bytes under a content-addressed `.mjs` path.
 * @param asset - Validated SDK source and fingerprint.
 * @param cacheDirectory - Directory for the local module snapshot.
 * @returns Absolute path to the verified module file.
 * @throws {Error} If an existing file has an unexpected fingerprint.
 */
async function persistSdk(asset: CdnAsset, cacheDirectory: string): Promise<string> {
  const filePath = resolve(cacheDirectory, `sdk-${asset.hash}.mjs`);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(filePath, asset.content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(filePath);
    if (sha256(existing) !== asset.hash) throw new Error('SDK 缓存内容与预期 SHA-256 不一致');
  }
  return filePath;
}

/**
 * Disable automatic resource execution and fetching in Happy DOM.
 * @param window - Registered Happy DOM browser window.
 * @returns Nothing.
 */
function disableAutomaticResourceLoading(window: SignBrowserWindow): void {
  const settings = window.happyDOM?.settings;
  if (!settings) return;
  const overrides: Record<string, boolean> = {
    enableJavaScriptEvaluation: false,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    enableCSSFileLoading: false,
    disableCSSFileLoading: true,
    enableImageFileLoading: false,
    enableIframePageLoading: false,
    handleDisabledFileLoadingAsSuccess: true,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key in settings) settings[key] = value;
  }
}

/**
 * Validate stable HTML prerequisites used by the current Sign SDK.
 * @param document - Document after injecting the matched HTML.
 * @returns Number of SVGs and whether the chosen SVG path exists.
 * @throws {Error} When required meta data or SVG elements are missing.
 */
function validateSignatureDom(document: Document): { svgCount: number; selectedPathExists: boolean } {
  const svgNodes = Array.from(document.querySelectorAll(SVG_SELECTOR));
  const firstMeta = document.querySelector('[name^="tw"]');
  const encoded = firstMeta?.getAttribute('content');
  if (!encoded) throw new Error('HTML 中缺少 SDK 所需的 twitter meta 数据');
  let decoded: string;
  try { decoded = globalThis.atob(encoded); }
  catch { throw new Error('twitter meta 内容不是有效的 Base64'); }
  if (decoded.length < 6) throw new Error('twitter meta 内容长度异常');
  const chosenIndex = decoded.charCodeAt(5) % 4;
  const chosenSvg = svgNodes[chosenIndex];
  const chosenPath = chosenSvg?.childNodes[0]?.childNodes[1] as Element | undefined;
  const selectedPathExists = chosenPath?.localName === 'path' && Boolean(chosenPath.getAttribute('d'));
  if (svgNodes.length !== 4 || !selectedPathExists) {
    throw new Error('HTML 缺少完整的 4 个动画 SVG 或目标 path，可能与 SDK 版本不配套');
  }
  return { svgCount: svgNodes.length, selectedPathExists };
}

/**
 * Import a fresh SDK instance and invoke its asynchronous factory.
 * @param filePath - Absolute path to the content-verified SDK snapshot.
 * @param options - Runtime options used for diagnostics.
 * @returns Signer function created by the SDK initializer.
 * @throws {TypeError} If the SDK exports do not match the expected contract.
 */
async function initializeSigner(filePath: string, options: ResolvedSignOptions): Promise<Signer> {
  const url = pathToFileURL(filePath);
  // Imported source can capture window at module evaluation time. A fresh query
  // avoids reusing a module bound to an earlier, already-unregistered DOM.
  url.searchParams.set('mustLoginRun', String(++importSequence));
  const module = await import(url.href) as { default?: () => Promise<unknown> | unknown };
  if (typeof module.default !== 'function') throw new TypeError('SDK 默认导出不是初始化函数');
  const signer = await module.default();
  debug(options, 'SDK 初始化完成', { signerType: typeof signer });
  if (typeof signer !== 'function') throw new TypeError('SDK 初始化结果不是签名函数');
  return signer as Signer;
}

/**
 * Race an asynchronous signer with a timeout without aborting its execution.
 * @typeParam T - Result type returned by the signer.
 * @param action - Asynchronous signature operation.
 * @param timeoutMs - Maximum time before rejecting the returned Promise.
 * @returns The signer's result if it finishes before the timeout.
 * @throws {Error} When the timeout elapses first.
 */
async function withSignTimeout<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`签名生成超过 ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Generate an X Sign SDK signature from the latest HTML-matched SDK.
 *
 * Calls are serialized because Happy DOM registers `window`, `document` and
 * other browser APIs on the Node.js global object. Each invocation downloads
 * the current HTML/CDN references and creates a fresh browser environment.
 * The signature itself is never logged. Errors are thrown rather than encoded
 * into a Base64 error token.
 *
 * @param input - SDK path/input argument. Defaults to `jf`.
 * @param method - Request method, normalized to upper case. Defaults to `PATCH`.
 * @param options - Network, timeout, logging and remote execution options.
 * @returns The signature string produced by the SDK.
 * @throws {Error} When remote execution has not been explicitly enabled, when
 * discovery/DOM validation fails, or when the SDK returns an invalid signature.
 * @example
 * ```ts
 * const signature = await generateSign('jf', 'PATCH', {
 *   allowRemoteSdkExecution: true,
 *   verbose: false,
 * });
 * ```
 */
export async function generateSign(
  input = 'jf',
  method = 'PATCH',
  options: SignOptions = {},
): Promise<string> {
  if (!options.allowRemoteSdkExecution) {
    throw new Error('执行远程 SDK 需要显式设置 allowRemoteSdkExecution: true');
  }
  const normalizedInput = input.trim();
  const normalizedMethod = method.trim().toUpperCase();
  if (!normalizedInput || !normalizedMethod) throw new TypeError('签名 input 和 method 不能是空字符串');
  const settings = resolveOptions(options);
  return withExclusiveDom(async () => {
    let environmentInitialized = false;
    let restoreAnimation: (() => void) | undefined;
    try {
      settings.logger.info('正在发现当前 HTML 与配套 SDK');
      const html = await fetchHtml(settings);
      const discovery = await discoverSdk(html, settings);
      const asset = await fetchAsset(discovery.sdkUrl, 'sdk', discovery.referer, settings);
      const sdkPath = await persistSdk(asset, settings.cacheDirectory);
      settings.logger.info('SDK 下载完成', { sha256: asset.hash.slice(0, 12) });

      // Every network operation must finish before registering Happy DOM. Its
      // global AbortSignal is not compatible with the native Undici fetch.
      GlobalRegistrator.register({ url: HTML_URL, width: 1920, height: 1080 });
      environmentInitialized = true;
      const window = globalThis.window as unknown as SignBrowserWindow;
      const document = globalThis.document;
      window.happyDOM.settings.canvasAdapter = new CanvasAdapter();
      disableAutomaticResourceLoading(window);
      restoreAnimation = installAnimationComputedStyleBridge(window, {
        onCreate: details => debug(settings, '动画创建', details),
        onSample: details => debug(settings, '动画采样', { ...details }),
        onUnsupported: details => debug(settings, '不支持的动画采样', details),
      });
      document.open();
      document.write(html);
      document.close();
      debug(settings, 'DOM 前置校验完成', validateSignatureDom(document));

      const signer = await initializeSigner(sdkPath, settings);
      const value = await withSignTimeout(
        async () => await signer(normalizedInput, normalizedMethod),
        settings.signTimeoutMs,
      );
      if (typeof value !== 'string' || !value) throw new TypeError('SDK 返回了空值或非字符串签名');
      settings.logger.info('签名生成成功', { length: value.length });
      return value;
    } catch (error) {
      settings.logger.error('签名生成失败', { reason: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      try { restoreAnimation?.(); }
      finally { if (environmentInitialized) await GlobalRegistrator.unregister(); }
    }
  });
}

/**
 * Decide whether a request URL belongs to the observed Sign SDK call sites.
 *
 * Only HTTPS URLs from an explicit host set or first-party API path prefixes
 * are accepted. This is a routing convenience, not an authorization check.
 *
 * @param input - URL instance or absolute URL string.
 * @returns Whether the URL is eligible for Sign SDK signing.
 * @throws {TypeError} When the supplied string is not a valid absolute URL.
 */
export function shouldGenerateSign(input: URL | string): boolean {
  const url = typeof input === 'string' ? new URL(input) : input;
  if (url.protocol !== 'https:') return false;
  if (SIGN_HOSTNAMES.has(url.hostname) || url.hostname.endsWith('.jf.x.com')) return true;
  return SIGN_URL_PREFIXES.some(prefix =>
    url.href === prefix || url.href.startsWith(`${prefix}/`) || url.href.startsWith(`${prefix}?`),
  );
}

/**
 * Generate a request signature after resolving the URL-specific SDK arguments.
 *
 * Requests to `jf.x.com` and its subdomains use `('jf', 'PATCH')`, matching
 * the observed SDK call branch. Other supported URLs use their pathname and
 * the supplied HTTP method. Unsupported URLs return undefined without fetching.
 *
 * @param input - URL instance or absolute URL string to evaluate.
 * @param requestMethod - HTTP method for non-JF URLs. Default: `GET`.
 * @param options - Signing configuration passed through to `generateSign`.
 * @returns SDK signature, or undefined when signing is not required.
 * @throws {Error} When an eligible URL cannot be signed successfully.
 */
export async function generateSignForUrl(
  input: URL | string,
  requestMethod = 'GET',
  options: SignOptions = {},
): Promise<string | undefined> {
  const url = typeof input === 'string' ? new URL(input) : input;
  if (!shouldGenerateSign(url)) return undefined;
  const jfHost = url.hostname === 'jf.x.com' || url.hostname.endsWith('.jf.x.com');
  return generateSign(
    jfHost ? 'jf' : url.pathname.trim(),
    jfHost ? 'PATCH' : requestMethod,
    options,
  );
}
