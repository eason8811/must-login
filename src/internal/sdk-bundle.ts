import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { init as initModuleLexer, parse as parseModule } from 'es-module-lexer';

/** Maximum modules downloaded for one SDK dependency graph. */
const MAX_SDK_MODULES = 64;
/** Maximum total size of one SDK dependency graph (50 MiB). */
const MAX_SDK_GRAPH_BYTES = 50 * 1024 * 1024;

/** Content and origin metadata required for a downloaded ESM module. */
export interface SdkModuleAsset {
  /** Verified original CDN URL, used to resolve relative imports. */
  url: URL;
  /** Complete UTF-8 JavaScript source. */
  content: string;
  /** SHA-256 fingerprint of the downloaded source. */
  hash: string;
}

/** Dependency fetching and diagnostic callbacks supplied by the SDK caller. */
export interface SdkBundleOptions<TAsset extends SdkModuleAsset> {
  /** Parent directory used for isolated per-run module graphs. */
  cacheDirectory: string;
  /**
   * Download and validate a dependency against the caller's CDN policy.
   * @param url - Absolute URL resolved against the importing CDN module.
   * @param referer - Original CDN URL of the importing module.
   * @returns Verified dependency module and its source metadata.
   */
  fetchDependency(url: URL, referer: string): Promise<TAsset>;
  /**
   * Optional diagnostic hook for module-graph events.
   * @param message - Diagnostic event title.
   * @param details - Non-sensitive module-graph metadata.
   * @returns Nothing.
   */
  debug?(message: string, details: Readonly<Record<string, unknown>>): void;
}

/**
 * Persist an SDK entry and its complete statically discoverable ESM graph.
 *
 * Static imports, re-exports, and literal dynamic imports are resolved using
 * the original CDN URL of each module. All module basenames are preserved so
 * that the SDK's relative imports continue to work after saving locally.
 * Each call creates a unique directory and an ESM `package.json`, avoiding
 * Node module-cache reuse across different Happy DOM sessions.
 *
 * Network validation remains the responsibility of `fetchDependency`; only
 * simple same-directory `./<hash>.js` references are supported. Non-literal
 * dynamic imports are reported but cannot be prefetched without execution.
 *
 * @typeParam TAsset - Validated asset type used by the calling SDK.
 * @param rootAsset - Downloaded SDK entry with its original CDN URL.
 * @param options - Cache location, downloader, and optional diagnostics.
 * @returns Absolute pathname to the locally materialized SDK entry.
 * @throws {Error} When an import path is unsupported or graph limits are exceeded.
 */
export async function persistSdkBundle<TAsset extends SdkModuleAsset>(
  rootAsset: TAsset,
  options: SdkBundleOptions<TAsset>,
): Promise<string> {
  await initModuleLexer();
  await mkdir(options.cacheDirectory, { recursive: true, mode: 0o700 });

  const bundleDirectory = await mkdtemp(resolve(options.cacheDirectory, `sdk-${rootAsset.hash.slice(0, 12)}-`));
  await writeFile(resolve(bundleDirectory, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });

  const queue: TAsset[] = [rootAsset];
  const visited = new Set<string>([rootAsset.url.href]);
  let totalBytes = 0;

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const filename = basename(current.url.pathname);
    if (!/^[A-Za-z0-9_-]+\.js$/.test(filename)) {
      throw new Error(`SDK 模块文件名不符合预期：${filename}`);
    }

    totalBytes += Buffer.byteLength(current.content);
    if (totalBytes > MAX_SDK_GRAPH_BYTES) throw new Error('SDK 依赖总大小超过限制');
    await writeFile(resolve(bundleDirectory, filename), current.content, { flag: 'wx', mode: 0o600 });

    const [imports] = parseModule(current.content);
    for (const item of imports) {
      if (item.type !== 'static' && item.type !== 'dynamic') continue;
      const specifier = item.specifier;
      if (typeof specifier !== 'string') {
        options.debug?.('SDK 存在无法静态分析的动态导入', { module: filename });
        continue;
      }
      if (!/^\.\/[A-Za-z0-9_-]+\.js$/.test(specifier)) {
        throw new Error(`SDK 存在不支持的模块引用：${specifier}`);
      }
      const dependencyUrl = new URL(specifier, current.url);
      if (visited.has(dependencyUrl.href)) continue;
      if (visited.size >= MAX_SDK_MODULES) throw new Error('SDK 依赖模块数量超过限制');
      visited.add(dependencyUrl.href);
      queue.push(await options.fetchDependency(dependencyUrl, current.url.href));
    }
  }

  options.debug?.('SDK 依赖图下载完成', {
    moduleCount: visited.size,
    totalBytes,
    bundleDirectory,
  });
  return resolve(bundleDirectory, basename(rootAsset.url.pathname));
}
