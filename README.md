# @must/login

TypeScript 工具库项目骨架，构建产物同时支持 **ESM `import`**、**CommonJS `require`** 和 TypeScript 类型提示。

> 当前代码是演示性质的登录适配器，不包含实际的登录 HTTP 协议、Token 存储、密码校验或加密逻辑。请按照真实业务需求替换 `src/login.ts`。

## 环境

- Node.js 20+
- pnpm（建议使用团队统一的版本）

本项目的 `pnpm-workspace.yaml` 仅允许 `esbuild` 执行依赖安装脚本（pnpm 11+ 的构建审批机制），不对其他依赖开放执行权限。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run typecheck:consumer
pnpm test
```

开发监听：

```bash
pnpm dev
```

发布前完整检查：

```bash
pnpm check
pnpm pack
```

`prepack` 会在打包前自动运行 `check`（源码类型检查、构建、双模块消费者类型检查及 ESM/CJS 运行测试）。

## 构建产物

```text
dist/
├── index.js       # ESM
├── index.cjs      # CommonJS
├── index.d.ts     # ESM TypeScript 声明
├── index.d.cts    # CommonJS TypeScript 声明
└── *.map          # Source maps
```

`package.json` 中的条件导出分别指向相应的运行时和类型入口。`files` 白名单确保 npm 包主要包含 `dist` 产物及 npm 自动包含的必要元信息。

## 消费者使用示例

ESM：

```ts
import { createLoginClient } from '@must/login';

const loginClient = createLoginClient(async ({ username, password }) => {
  // 此处接入你的真实认证服务；不要在日志中输出密码。
  void password;
  return { user: username, accessToken: 'example-only' };
});

const result = await loginClient.login({
  username: 'eason',
  password: 'example',
});
console.log(result.user);
```

CommonJS：

```js
const { createLoginClient } = require('@must/login');

const loginClient = createLoginClient(async ({ username }) => ({ user: username }));
```

## 本地安装测试

在项目目录执行：

```bash
pnpm pack
```

然后在**另一个项目**使用生成的 `must-login-0.1.0.tgz` 文件，例如：

```bash
pnpm add ../must-login/must-login-0.1.0.tgz
```

注意：示例中的路径需根据实际目录调整。建议测试 `import`、`require`，以及 TypeScript 的 `moduleResolution: NodeNext` 模式。

## 对外发布前

此骨架默认设置了 `"private": true` 和 `"license": "UNLICENSED"`，用于防止误发布并保留许可证决策。

如果决定正式发布：

1. 确认你拥有 npm Registry 上的 `@must` 命名空间或组织发布权限；如无权限，修改 `name`。
2. 根据项目实际使用授权，确定 `license`；若希望开源，请添加相应 LICENSE 文件。
3. 确认确实允许发布后，将 `private` 改为 `false`（或移除该字段）。
4. 运行 `pnpm check`、`pnpm pack`，检查压缩包中不含密钥或隐私数据。
5. 根据 Registry 的身份认证与权限要求，运行：

```bash
pnpm login --registry=https://registry.npmjs.org/
pnpm publish --dry-run
pnpm publish --access public
```

## 常见扩展

- 需要浏览器运行：调整 `platform` 和入口设计，避免把 Node.js 专用模块打进浏览器构建。
- 需要子路径导出：新增 `src` 入口并同步修改 `exports`。
- 需要真实鉴权：实现具体适配器，明确超时、异常、凭据处理与 Token 生命周期。
- 需要 CI 发布：测试稳定后引入 GitHub Actions / GitLab CI 和受信任的发布机制。

## 目录

```text
src/            TypeScript 源代码（只在 index.ts 中暴露公共 API）
test/           ESM 和 CommonJS 运行时烟雾测试
type-tests/     ESM 和 CommonJS TypeScript 消费者类型检查
dist/           构建输出（不提交 Git）
tsup.config.ts  双格式构建配置
tsconfig.json   TypeScript 严格类型检查
```
