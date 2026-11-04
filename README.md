# @must/login

基于 TypeScript 的 X 平台 SDK 工具库，提供两种独立的异步能力：

- **Sign SDK**：`generateSign()` / `generateSignForUrl()`，根据请求参数生成签名。
- **Castle SDK**：`generateCastleToken()`，自动发现当前 SDK 和配套公钥（`pk`），生成请求 Token。

两者均从最新的 X HTML 出发，识别已采用哈希命名的 JavaScript 资源，在 Happy DOM 中执行对应 SDK。支持 **ESM `import`、CommonJS `require`** 及其 TypeScript 类型声明。

> 运行环境：**Node.js 22+**。本工具会加载第三方动态 JavaScript，只应在你确认具有相关授权、信任下载来源及可接受运行风险的环境中使用。`allowRemoteSdkExecution` 必须明确设置为 `true`，避免误执行远程代码。

## 环境要求与安装

- Node.js **22 或更高版本**；本项目是 Node.js 库，不面向浏览器直接打包运行。
- 使用 pnpm 管理依赖；Happy DOM Canvas 适配器可能依赖系统原生组件。
- 能够访问 `https://x.com/` 和 `https://abs.twimg.com/`，或通过 `fetch` 自行提供网络请求实现。

在本仓库中安装、测试和打包：

```bash
pnpm install
pnpm check
pnpm pack
```

- `pnpm build`：使用 tsup 构建 ESM + CJS + 类型声明。
- `pnpm dev`：监听源码变化。
- `pnpm check`：源码类型检查、ESM/CJS 构建、消费者类型检查、运行时测试。
- `pnpm pack`：自动执行 `check` 并创建可安装的 `.tgz` 压缩包。

在其他项目中安装已打包的本地 `.tgz`：

```bash
pnpm add /absolute/path/to/must-login-0.1.0.tgz
```

pnpm 11+ 的依赖构建脚本审批由 `pnpm-workspace.yaml` 管理。本项目明确允许 `esbuild` 和 `canvas` 运行构建脚本；Canvas 可能需要当前操作系统的原生依赖或预编译二进制。

## 快速开始

### 1. Sign SDK：生成请求签名（ESM / TypeScript）

```ts
import {
  generateSign,
  generateSignForUrl,
  shouldGenerateSign,
  type SignOptions,
} from '@must/login';

const options: SignOptions = {
  allowRemoteSdkExecution: true,
  verbose: false,
};

// 默认参数：input='jf', method='PATCH'
const signature = await generateSign('jf', 'PATCH', options);

// 调用 SDK 时，method 会统一转成大写
const otherSignature = await generateSign('/i/api/example', 'get', options);

// 按请求 URL 判断；对于 jf.x.com 自动采用 ('jf', 'PATCH')
const eligible = shouldGenerateSign('https://jf.x.com/any/path'); // true
const requestSignature = await generateSignForUrl('https://jf.x.com/any/path', 'GET', options);
```

### 2. Castle SDK：自动获取公钥并生成 Token（ESM / TypeScript）

```ts
import { generateCastleToken, type CastleOptions } from '@must/login';

const options: CastleOptions = {
  allowRemoteSdkExecution: true,
  verbose: false,
  tokenTimeoutMs: 15_000,
};

// 不需要手动传入 Castle SDK 文件路径或 pk 公钥
const token: string = await generateCastleToken(options);
```

`generateCastleToken()` 内部依次完成：下载当前 HTML → 解析 Entry → 找到 Castle 调用模块 → 定位其动态导入的 SDK → 在静态配置模块中提取 `responsive_web_castle_public_key` → 执行 `configure({ pk })` → 调用 `createRequestToken()`。

函数仅返回非空 Token 字符串；下载、SDK 配置或生成失败时抛出异常。

### 3. CommonJS：通过 `require` 调用

```js
const { generateSign, generateCastleToken } = require('@must/login');

async function main() {
  const options = { allowRemoteSdkExecution: true };
  const signature = await generateSign('jf', 'PATCH', options);
  const token = await generateCastleToken(options);
  console.log({ signatureLength: signature.length, tokenLength: token.length });
}

main().catch(console.error);
```

## 公共 API

| 导出成员 | 类型 | 说明 |
|---|---|---|
| `generateSign` | 函数 | 生成 Sign SDK 签名 |
| `shouldGenerateSign` | 函数 | 判断 URL 是否符合当前签名路由规则 |
| `generateSignForUrl` | 函数 | 按 URL 自动选择 Sign SDK 参数，不适用时返回 `undefined` |
| `generateCastleToken` | 函数 | 自动发现并执行 Castle SDK，返回 Token |
| `SignOptions` / `CastleOptions` | 接口 | 两种工具的配置类型 |
| `SignLogger` / `CastleLogger` | 接口 | 可替换的日志输出接口 |
| `SignLogLevel` / `SignLogDetails` | 类型 | Sign 日志等级和结构化日志详情类型 |

### Sign SDK

函数签名：

```ts
generateSign(
  input?: string,        // 默认 'jf'
  method?: string,       // 默认 'PATCH'，内部统一转换成大写
  options?: SignOptions, // 默认仅使用关键日志，不允许执行远程代码
): Promise<string>

shouldGenerateSign(url: string | URL): boolean

generateSignForUrl(
  url: string | URL,
  method?: string,       // 默认 'GET'
  options?: SignOptions,
): Promise<string | undefined>
```

`generateSignForUrl(url, method, options)` 会先使用 `shouldGenerateSign(url)` 检查 URL，若不在支持的请求范围内就返回 `undefined`，不会执行网络请求；对于 `jf.x.com` 及其子域名自动采用固定的 `jf/PATCH` 参数。

签名失败时**抛出异常**，而不是把错误包装为 Base64 字符串，避免错误文本被当作有效签名。工具不会主动把签名值输出到日志。

### SignOptions

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `allowRemoteSdkExecution` | `boolean` | `false` | 显式允许导入并执行远程 SDK |
| `verbose` | `boolean` | `false` | 是否显示详细资源/DOM/动画日志 |
| `fetchTimeoutMs` | `number` | `15000` | HTML 下载超时，毫秒 |
| `sdkFetchTimeoutMs` | `number` | `15000` | 每个 JavaScript 资源下载超时，毫秒 |
| `signTimeoutMs` | `number` | `15000` | SDK 签名 Promise 超时，毫秒 |
| `htmlHeaders` | `Record<string,string>` | `{}` | HTML 请求 Header 覆盖项 |
| `sdkHeaders` | `Record<string,string>` | `{}` | CDN JavaScript 请求 Header 覆盖项 |
| `cacheDirectory` | `string` | 系统临时目录下的 `must-login-sign` | SDK 快照缓存目录 |
| `logger` | `SignLogger` | 控制台 | 自定义日志输出端 |
| `fetch` | `typeof globalThis.fetch` | Node 原生 fetch | 可注入网络实现，便于配置网络出口或离线测试 |

### Castle SDK

函数签名：

```ts
generateCastleToken(options?: CastleOptions): Promise<string>
```

Castle 不需要调用方传入本地 SDK 路径或固定公钥。当前实现会从同一次 HTML 发现链中提取对应公钥，并优先使用 `configure()` 返回的、带有 `createRequestToken()` 方法的实例；如果没有返回这样的实例，则使用 SDK 默认导出对象。

#### CastleOptions

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `allowRemoteSdkExecution` | `boolean` | `false` | 显式允许执行从 CDN 下载的 Castle SDK |
| `verbose` | `boolean` | `false` | 是否打印资源发现及 SDK 初始化细节 |
| `fetchTimeoutMs` | `number` | `15000` | HTML 下载超时，毫秒 |
| `sdkFetchTimeoutMs` | `number` | `15000` | 每个 CDN JavaScript 资源下载超时，毫秒 |
| `tokenTimeoutMs` | `number` | `15000` | `createRequestToken()` 等待超时，毫秒 |
| `htmlHeaders` | `Record<string,string>` | `{}` | HTML 请求 Header 覆盖项 |
| `sdkHeaders` | `Record<string,string>` | `{}` | CDN 资源请求 Header 覆盖项 |
| `cacheDirectory` | `string` | 系统临时目录下的 `must-login-castle` | Castle SDK 快照缓存目录 |
| `logger` | `CastleLogger` | 控制台 | 自定义日志输出端 |
| `fetch` | `typeof globalThis.fetch` | Node 原生 fetch | 可注入自定义网络实现或离线测试模拟器 |

两类选项中的超时时间必须是正整数（毫秒）。IDE 可通过导出函数、接口及类型的 TSDoc 查看参数说明。

### 自定义日志

```ts
const signature = await generateSign('jf', 'PATCH', {
  allowRemoteSdkExecution: true,
  verbose: true,
  logger: {
    info: (message, details) => console.info(message, details),
    warn: (message, details) => console.warn(message, details),
    error: (message, details) => console.error(message, details),
    debug: (message, details) => console.debug(message, details),
  },
});
```

上例的 `logger` 同样适用于 `generateCastleToken()`；`CastleLogger` 与 `SignLogger` 具有相同方法。

默认只记录关键生命周期事件：资源发现、SDK 下载、生成成功或失败。设置 `verbose: true` 后，Sign 还会输出 DOM 校验、动画诊断，Castle 则会输出资源哈希、来源与 SDK 配置状态。实现不会主动输出完整签名、Token、公钥、HTML 正文或认证 meta 值。

## 资源自动发现机制

当前 X 构建已将部分 JavaScript 资源名改为纯哈希，本项目**不依赖** `startup-dynamic-*`、`sign.o-*`、`castle.umd-*` 等旧文件名前缀。

两个 SDK 共用相同的发现起点，但通过不同的代码特征定位目标：

```text
https://x.com/ HTML
  └─ entry-client-logged-out-<hash>.js
      └─ Entry 的直接静态 import（筛选哈希 chunk）
          ├─ Sign 调用模块（含 jf.x.com / .jf.x.com / PATCH 特征）
          │   └─ import('./<hash>.js').then(e => e.default())
          │       └─ Sign SDK
          └─ Castle 调用模块（含 Castle 开关、getStringValue 和 configure）
              ├─ 动态 import('./<hash>.js') → Castle SDK
              └─ 直接静态 import 的配置 chunk
                  └─ responsive_web_castle_public_key → pk 公钥
```

- **Sign**：检查 Entry 的直接静态依赖，以 `jf.x.com`、`.jf.x.com`、`PATCH` 的组合特征识别唯一调用模块，再解析 SDK 默认工厂函数的动态导入。
- **Castle**：检查 Entry 的直接静态依赖，以 `responsive_web_castle_sdk_enabled`、`getStringValue('responsive_web_castle_public_key')`、`configure({ pk })` 识别唯一调用模块；从该模块静态依赖中的配置对象读取唯一公钥，并解析调用链中的 SDK 动态导入。
- **匹配边界**：静态依赖使用 `es-module-lexer` 解析，排除 Vite 预加载映射中仅作为字符串出现的文件名；发现多个匹配项或未发现匹配项时会抛错。下载目标限制在预期的 HTTPS CDN 资源路径。

当前两套实现分别执行发现流程，**不会共用网络请求结果**。资源哈希文件和公钥会随着 X 的构建或配置变化自动重新发现；若上游代码结构发生变化，仍可能需要更新特征匹配逻辑。

## 从探索入口迁移的配置

### Sign 入口

| 原环境变量/模式 | 当前处理方式 |
|---|---|
| `SIGN_INPUT`、`SIGN_METHOD` | 改为 `generateSign(input, method, options)`，默认 `'jf', 'PATCH'` |
| `SIGN_FETCH_TIMEOUT_MS` | `options.fetchTimeoutMs` |
| `SIGN_SDK_FETCH_TIMEOUT_MS` | `options.sdkFetchTimeoutMs` |
| `SIGN_TIMEOUT_MS` | `options.signTimeoutMs` |
| `SIGN_HEADERS_JSON` | `options.htmlHeaders` |
| `SIGN_SDK_FETCH_HEADERS_JSON` | `options.sdkHeaders` |
| `SIGN_ALLOW_REMOTE_SDK_EXECUTION` | `options.allowRemoteSdkExecution`，安全默认 `false` |
| `SIGN_MODE` | 移除 `probe/fetch/import/initialize`，仅保留完整签名流程 |
| `SIGN_SDK_SOURCE`、SDK 本地路径和固定 URL | 移除，始终从当前 HTML 自动发现配套 SDK |
| `SIGN_FETCH_URL` | 固定为 `https://x.com/` |
| `SIGN_SVG_SELECTOR`、`SIGN_STRICT_DOM` | 内部常量，启用稳定 SVG 结构检查 |
| 动画桥接、监控、探针和 settle 开关 | 桥接固定开启，探索期监控/探针/等待逻辑移除 |
| SDK/HTML 期望哈希和发现资源快照 | 移除；SDK 源文件仅以 SHA-256 命名缓存用于 Node 导入 |
| `SIGN_SHOW_RESULT`、JSONL 日志 | 移除；返回签名值，日志永不打印签名正文 |

### Castle 入口

| 原环境变量/探索行为 | 当前处理方式 |
|---|---|
| `CASTLE_SDK_PATH` | 移除；自动从当前 HTML → Entry → Castle 调用模块发现 SDK |
| `CASTLE_PUBLIC_KEY` | 移除；从该调用模块的静态配置依赖中自动提取公钥 |
| `CASTLE_MODE=import/configure/token` | 移除探索模式；统一执行完整 Token 生成流程 |
| `CASTLE_ENABLE_IFRAME` | 不公开；Happy DOM 内部固定禁止 iframe 页面加载 |
| `tokenTimeoutMs` | 生产环境通过 `CastleOptions.tokenTimeoutMs` 配置 |
| `settleMs`、`postConfigureObserveMs`、`postTokenObserveMs` | 移除探索期额外等待逻辑 |
| 事件/Canvas 监控、生命周期探针、JSONL 和 fatal 日志 | 移除；改为可注入的精简日志 + `verbose` 调试日志 |
| `configure({ pk })` 与 `createRequestToken()` | 保留为正式 SDK 调用顺序，并兼容 `configure()` 返回新实例的情况 |

## 重要运行特征

1. **每次重新发现**：调用 Sign 或 Castle 均会请求最新 HTML 和相关 CDN 资源；SDK 内容按 SHA-256 缓存至磁盘，但发现流程和实际 SDK 初始化不会直接复用上一次结果。上游资源发布并非原子事务，极端情况下可能获取到跨版本文件。
2. **共享全局 DOM 锁**：Happy DOM 注册时会修改 Node 的 `globalThis`。同一模块实例内，Sign 和 Castle 使用同一异步锁串行执行，并在各自结束后注销环境。它不能替进程内其他未使用该锁的 DOM 库提供隔离，也不能跨 ESM/CJS 独立装载实例或 Node 进程协调。
3. **动态导入不复用旧 DOM**：每次导入 SDK 均添加不同的模块 URL 查询参数，确保代码绑定当前 DOM。高频使用会增加模块缓存占用，后续可以考虑进程或 Worker 级隔离、会话复用和资源共享缓存。
4. **超时不等于中止**：`signTimeoutMs`、`tokenTimeoutMs` 仅限制等待结果的时间，不能终止已经运行的第三方 SDK。若需要严格的 CPU、内存和执行时间隔离，应在独立进程中运行并实现硬超时。
5. **下载代码存在执行风险**：即使限制了资源的来源域名和路径，实际执行的仍是远程第三方 JavaScript。只有明确接受风险时才设置 `allowRemoteSdkExecution: true`。
6. **真实环境验证仍然必要**：仓库的自动化测试使用离线 HTML、SDK 和公钥模拟数据，覆盖 ESM/CJS、资源歧义拒绝及 Sign/Castle 并发串行化；**这并不等同于验证最新线上 SDK 真实签名或 Token 可用性**。

## 构建产物

```text
dist/
├── index.js       # ESM
├── index.cjs      # CommonJS
├── index.d.ts     # ESM 类型声明
├── index.d.cts    # CommonJS 类型声明
└── *.map          # Source maps
```

当前 `package.json` 仍为 `private: true`、`license: "UNLICENSED"`，可先用于本地打包和安装测试。若计划发布 npm registry，需要确认 `@must` scope 权限、许可证及发布策略后再修改发布配置。
