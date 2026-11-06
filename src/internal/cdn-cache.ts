import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Maximum number of cached resources currently being fetched in one process. */
const inFlight = new Map<string, Promise<CachedCdnText>>();

/** Persisted envelope for a validated, immutable CDN text response. */
interface CacheRecord {
  /** Format version used to reject incompatible old cache entries. */
  version: 1;
  /** Canonical CDN URL associated with the saved bytes. */
  url: string;
  /** SHA-256 checksum of the UTF-8 resource contents. */
  sha256: string;
  /** Original JavaScript source as UTF-8 text. */
  content: string;
}

/** A resource loaded from disk or downloaded from the CDN. */
export interface CachedCdnText {
  /** Complete JavaScript source, never executed by this utility. */
  content: string;
  /** SHA-256 fingerprint of the validated source. */
  hash: string;
  /** Actual UTF-8 source byte count. */
  size: number;
  /** Whether the returned resource was read from the persistent disk cache. */
  fromCache: boolean;
}

/** Settings for one source-only CDN cache operation. */
export interface CdnCacheOptions {
  /** Already validated, canonical HTTPS CDN asset URL. */
  url: URL;
  /** Root directory selected by the invoking Sign/Castle/Authorization tool. */
  cacheDirectory: string;
  /** Maximum accepted UTF-8 size of this resource. */
  maxBytes: number;
  /** Fetch and validate the full resource when there is no valid cache entry. */
  fetchRemote(): Promise<string>;
  /** Optional metadata-only diagnostics; no JavaScript or credentials are emitted. */
  debug?(message: string, details: Readonly<Record<string, unknown>>): void;
}

/**
 * Calculate a SHA-256 digest for a cache URL or JavaScript source.
 * @param input - Source string whose exact UTF-8 bytes are hashed.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
function fingerprint(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Construct a stable, filesystem-safe cache path from the entire CDN URL.
 * @param cacheDirectory - Per-tool cache root.
 * @param url - Validated absolute resource URL.
 * @returns Absolute path to the JSON source-cache record.
 */
function cacheFile(cacheDirectory: string, url: URL): string {
  const key = fingerprint(url.href);
  return resolve(cacheDirectory, 'assets', key.slice(0, 2), `${key}.json`);
}

/**
 * Validate a cache record independently of its filename.
 * @param value - Untrusted JSON value read from disk.
 * @param url - Expected exact CDN URL.
 * @param maxBytes - Maximum permitted source byte count.
 * @returns Verified resource or undefined if the cache is corrupt or outdated.
 */
function validateRecord(value: unknown, url: URL, maxBytes: number): CachedCdnText | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<CacheRecord>;
  if (candidate.version !== 1 || candidate.url !== url.href ||
      typeof candidate.content !== 'string' || !candidate.content.trim() ||
      typeof candidate.sha256 !== 'string') return undefined;

  const size = Buffer.byteLength(candidate.content);
  if (size > maxBytes) return undefined;
  const hash = fingerprint(candidate.content);
  return hash === candidate.sha256 ? { content: candidate.content, hash, size, fromCache: true } : undefined;
}

/**
 * Attempt to load a resource without performing any HTTP requests.
 * @param path - Stable path to the cached JSON record.
 * @param options - Expected URL and maximum byte count.
 * @returns Validated resource when present; undefined for missing/invalid entries.
 * @throws {Error} For filesystem errors other than a missing file.
 */
async function readCache(path: string, options: CdnCacheOptions): Promise<CachedCdnText | undefined> {
  let raw: string;
  try {
    // JSON escaping can enlarge the source; cap the envelope before loading it.
    const info = await stat(path);
    if (!info.isFile() || info.size > options.maxBytes * 6 + 16_384) return undefined;
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  // A corrupt or truncated cache file is never treated as a valid CDN response.
  try {
    return validateRecord(JSON.parse(raw), options.url, options.maxBytes);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Atomically replace one cache record after the remote response is validated.
 * @param path - Stable cache record pathname.
 * @param record - Immutable URL/source/checksum envelope.
 * @returns Nothing once the full record has been published.
 */
async function writeCache(path: string, record: CacheRecord): Promise<void> {
  const directory = resolve(path, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `${fingerprint(record.url)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * Read a version-addressed CDN JavaScript resource from disk or fetch it once.
 *
 * HTML must bypass this function and always be fetched afresh. The cached
 * source is keyed by its full CDN URL; a newly discovered hashed filename
 * therefore generates an independent cache entry. Resources are validated by
 * URL, maximum size and SHA-256 before reuse. Concurrent callers using the
 * same cache directory and URL share a single in-flight operation.
 *
 * The caller remains responsible for validating CDN URL restrictions, HTTP
 * status, redirects and content-type in `fetchRemote`. Only source text is
 * retained: SDK execution must still materialize a fresh ESM module graph.
 *
 * @param options - Cache directory, URL, limits and validated remote fetcher.
 * @returns Cached or downloaded source together with its integrity metadata.
 * @throws {Error} For invalid source content or filesystem/network failures.
 */
export async function fetchCachedCdnText(options: CdnCacheOptions): Promise<CachedCdnText> {
  const path = cacheFile(options.cacheDirectory, options.url);
  const inFlightKey = `${path}\u0000${options.maxBytes}`;
  const existing = inFlight.get(inFlightKey);
  if (existing) return existing;

  const pending = (async (): Promise<CachedCdnText> => {
    const saved = await readCache(path, options);
    if (saved) {
      options.debug?.('CDN 缓存命中', { url: options.url.href, size: saved.size, sha256: saved.hash });
      return saved;
    }
    options.debug?.('CDN 缓存未命中', { url: options.url.href });

    const content = await options.fetchRemote();
    const size = Buffer.byteLength(content);
    if (!content.trim() || size > options.maxBytes) {
      throw new Error('CDN 资源为空或超过缓存大小限制');
    }
    const hash = fingerprint(content);
    await writeCache(path, { version: 1, url: options.url.href, sha256: hash, content });
    options.debug?.('CDN 资源已写入缓存', { url: options.url.href, size, sha256: hash });
    return { content, hash, size, fromCache: false };
  })();

  inFlight.set(inFlightKey, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(inFlightKey);
  }
}
