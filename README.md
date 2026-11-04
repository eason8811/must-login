# @must/login

基于 TypeScript 的 X Sign SDK 签名工具函数。自动获取当前 HTML，追踪与之匹配的 `entry-client-logged-out → startup-dynamic → sign.o-*` 引用链，在 Happy DOM 中初始化 SDK，并返回签名字符串。

同时提供 ESM、CommonJS 和对应的 TypeScript 类型声明。

> 运行环境：**Node.js 22+**。本工具会加载第三方动态 JavaScript，只应在你确认具有相关授权、信任下载来源及可接受运行风险的环境中使用。`allowRemoteSdkExecution` 必须明确设置为 `true`，避免误执行远程代码。

## 安装与验证

```bash
pnpm install
pnpm check
pnpm pack
```

- `pnpm build`：使用 tsup 构建 ESM + CJS + 类型声明。
- `pnpm dev`：监听源码变化。
- `pnpm check`：源码类型检查、ESM/CJS 消费者类型检查、构建、运行时测试。
- `pnpm pack`：自动执行 `check` 并创建可安装的 `.tgz` 压缩包。

pnpm 11+ 的依赖构建脚本审批由 `pnpm-workspace.yaml` 管理。本项目明确允许 `esbuild` 和 `canvas` 运行构建脚本；Canvas 可能需要当前操作系统的原生依赖或预编译二进制。

## API

```ts
import { generateSign, generateSignForUrl, type SignOptions } from '@must/login';

const options: SignOptions = {
  allowRemoteSdkExecution: true,
  verbose: false,
};

// 默认参数：input='jf', method='PATCH'
const signature = await generateSign('jf', 'PATCH', options);

// 可通过其他合法输入调用 SDK；方法会转成大写
const otherSignature = await generateSign('/i/api/example', 'get', options);

// 根据 URL 自动决定是否需要签名，并处理 jf.x.com 的 jf/PATCH 特例
const requestSignature = await generateSignForUrl('https://jf.x.com/any/path', 'GET', options);
```

CommonJS：

```js
const { generateSign } = require('@must/login');

const signature = await generateSign('jf', 'PATCH', {
  allowRemoteSdkExecution: true,
});
```

参数说明：

```ts
generateSign(
  input?: string,        // 默认 'jf'
  method?: string,       // 默认 'PATCH'，内部统一转换成大写
  options?: SignOptions, // 默认仅使用关键日志，不允许执行远程代码
): Promise<string>
```

`generateSignForUrl(url, method, options)` 会先使用 `shouldGenerateSign(url)` 检查 URL，若不在支持的请求范围内就返回 `undefined`，不会执行网络请求；对于 `jf.x.com` 及其子域名自动采用固定的 `jf/PATCH` 参数。

签名失败时**抛出异常**，而不是把错误包装成 Base64 字符串。这能避免错误结果被误作为真实签名提交。工具不会将签名值打印到日志。

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
| `cacheDirectory` | `string` | OS 临时目录下的 `must-login-sign` | SDK 快照缓存目录 |
| `logger` | `SignLogger` | 控制台 | 自定义日志输出端 |
| `fetch` | `typeof globalThis.fetch` | Node 原生 fetch | 可注入网络实现，便于配置网络出口或离线测试 |

所有公开的 `interface`、`type` 和函数都带有 TSDoc。将鼠标悬停在 IDE 中的 `SignOptions`、`SignLogger`、`generateSign` 上即可查看类型及说明。

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

默认仅报告 HTML/SDK 发现阶段、SDK 下载、签名成功及异常；`verbose=true` 时才报告 URL、指纹、DOM 结构和动画采样。**不会记录**完整签名、HTML 内容、认证 meta 值或 SVG path 正文。

## 从原始入口迁移的配置

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

## 重要运行特征

1. **独立的 HTML + SDK 配套链**：每次调用都重新获取 HTML 和相应 SDK；下载过程中对 CDN 主机名、HTTPS 和路径形态做限制。由于 CDN 更新不是原子事务，极端情况下仍可能出现跨部署版本不一致。
2. **Happy DOM 是全局环境**：初始化会暂时修改 Node `globalThis`。本包将内部调用串行化，并在结束后撤销动画桥接、注销浏览器环境；不建议与同进程中其他使用全局 DOM 的工具并发运行。
3. **动态导入隔离**：为避免使用与上次 DOM 绑定的模块缓存，每次调用都以不同的模块 URL 查询参数重新导入 SDK。长时间高频调用可能增加模块缓存内存；生产高吞吐场景应考虑后续引入专用 Worker/进程池以及复用式签名会话。
4. **超时不是执行取消**：`signTimeoutMs` 只能让调用方及时收到异常，不能强制终止正在运行的第三方 JavaScript。强隔离和硬超时需要独立进程。
5. **实际 SDK 兼容性**：仓库包含离线模拟 HTML/SDK 的端到端测试；不同日期、部署版本的真实 SDK 仍需与真实浏览器产生的签名对照验证。

## 构建产物

```text
dist/
├── index.js       # ESM
├── index.cjs      # CommonJS
├── index.d.ts     # ESM 类型声明
├── index.d.cts    # CommonJS 类型声明
└── *.map          # Source maps
```

> 初始发布配置仍为 `private: true`、`license: "UNLICENSED"`。确认拥有 npm 的 `@must` scope 发布权限并明确许可证后，才能调整为公开发布。
