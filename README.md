# dsh-magpie

把 [magpie](https://github.com/yetone/magpie) 本机模型网关接入 DeepSeek Harness 的插件。

- **Provider**：`magpie` —— 网关上的全部模型自动出现在 DSH 的模型选择器里
- **面板**：侧边栏「Magpie」入口，iframe 嵌入 magpie 官方 Web UI

## 前置条件

magpie 网关必须已经在跑（本插件只做客户端，不负责启动网关）：

```bash
magpie            # 或直接打开 magpie 桌面应用
# 网关默认监听 127.0.0.1:3425
```

验证：

```bash
curl -s -H "Authorization: Bearer magpie" http://127.0.0.1:3425/v1/models
```

## 安装

```bash
# 1. 构建
node scripts/build.mjs

# 2. 装进 profile（把 <profile> 换成 desktop / web）
dsh plugin --profile <profile> install C:/Users/Betsy/.dsh/plugin-src/dsh-magpie

# 3. 重启 DSH
```

`package.json` 的 `dsh.bundle.patch` 会指向 `cordis.patch.yml`，它往插件树里插一条：

```yaml
- insert:
    - id: magpie
      name: 'dsh-magpie'
```

## 配置

插件配置走 DSH 设置里的 `magpie` 命名空间（schemastery schema，见 `src/config.ts`）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseURL` | `http://127.0.0.1:3425` | 网关地址 |
| `apiKey` | `magpie` | 网关 key（也可用环境变量 `MAGPIE_GATEWAY_KEY`） |
| `apiKeyEnv` | `MAGPIE_GATEWAY_KEY` | 从哪个环境变量读 key |
| `requestTimeoutMs` | `10000` | 非流式请求超时 |
| `streamIdleTimeoutMs` | `600000` | 流式空闲超时 |
| `catalogTtlMs` | `60000` | 模型目录缓存时长 |
| `modelInclude` | `[]` | 白名单 glob（空 = 全部） |
| `modelExclude` | `[]` | 黑名单 glob |
| `includeDisabledModels` | `true` | 是否包含「已在 Jet Hub 关闭」的模型 |
| `sessionHeader` | `true` | 是否发送 `X-Magpie-Session` |
| `webEnabled` | `true` | 是否嵌入原版 Web UI |
| `magpieBinary` | `magpie` | magpie 可执行文件路径 |
| `webHost` | `127.0.0.1` | Web UI 监听地址 |
| `webPort` | `3480` | Web UI 首选端口（占用时自动向后找空闲端口） |
| `webKey` | *(内置随机串)* | `MAGPIE_WEB_KEY`，需 16+ 字符 |

## 架构

```
src/
  index.ts        插件入口：注册 provider + 面板 RPC
  adapter.ts      MagpieAdapter extends LlmAdapter（stream / listModels / resolveModel / prepareCall）
  catalog.ts      模型目录（TTL 缓存 + /v1/models 解析 + 过滤）
  messages.ts     DSH RequestMessage[] → OpenAI messages（含 tool_calls / 图片 / reasoning）
  sse.ts          SSE 流解析（跨 chunk 多字节安全 + 空闲超时 + abort）
  http.ts         HTTP 客户端（错误分类 / 重试 / attribution headers）
  admin.ts        管理 API（quotas / usage / limit / concurrency / routes）
  web-bridge.ts   管理 magpie web 子进程 + 反向代理（登录取 cookie、注入转发、WS 透传）
  config.ts       schemastery 配置
  types.ts        magpie 线格式类型
  product.ts      常量

plugin-src/client/
  index.js        客户端入口：注册三处槽位
  panel.js        iframe 面板 + 加载/错误屏
  rpc.js          RPC 调用与解包
  styles.js       面板样式（幂等注入）
  error-boundary.js  错误边界（防止渲染异常炸掉整棵子树）
```

### provider 注册

`ctx.llm.registerAdapter(['magpie'], adapter)` —— 内部已 `ctx.effect`，插件卸载时自动注销。**不要再包一层** `ctx.effect`，否则二次释放会抛 `REGISTRATION_DISPOSED`。

### 模型目录

`GET /v1/models` 返回的字段直接映射到 DSH 的 `LlmResolvedModelInfo`：

- `context_window ?? context_length ?? max_input_tokens` → `context.contextWindow`
- `max_output_tokens` → `defaultMaxTokens`（缺失则不设）
- `reasoning_levels` → `reasoning.efforts`（**空数组时整个 `reasoning` 字段不出现**，否则 DSH 会抛 `INVALID_MODEL_REASONING`）
- `modalities.input` → `inputModalities`

### 面板 RPC

宿主持有 `connection.fetch.register({ path: '/api/magpie', methods: ['POST'] })`，客户端 `connection.rpc.call('/api', 'magpie', { method, payload })`。

**返回值契约**（必须严格遵守）：

```ts
{ ok: true, value: T } | { ok: false, error: { code: string, message: string, details?: {} } }
```

返回裸对象会被 `dsh-client-connection` 判为 `invalid server-response result`（界面上一堆看不懂的红条）。

### iframe 嵌入与反向代理

面板 iframe 指向的**不是** `magpie web` 自己的端口，而是插件起的**反向代理**
（`src/web-bridge.ts`）：

```
DSH 面板 (127.0.0.1:<gui-port>)
  └── iframe src="http://127.0.0.1:<proxyPort>/"
        └── 代理 ── 注入 Cookie ──> magpie web (127.0.0.1:<magpiePort>)
```

**为什么不能直连**：`magpie web` 靠 cookie 认证
（`magpie_web_<port>=<token>`）。DSH 自己的 `dsh-auth-cookie-guard` 在
`127.0.0.1` 上每启动一次就留一个 ~173 字符、30 天有效期的启动 cookie，
累积到 **16 KB**（源码注释：`Cookie header alone is 16184 bytes`），
把该 host 的 cookie 配额占满，浏览器随即驱逐 magpie 的 cookie。magpie 登录页
原话就是「or by filling the host's cookie limit」。

**代理怎么解决**：cookie 由代理在**服务端**注入到每个转发请求的 `Cookie` 头，
iframe 完全不需要浏览器保存任何 cookie，因此不受配额影响。代理还**剥离**上游
的 `Set-Cookie`，避免反向污染 DSH 的 cookie 池。

其它实现要点：

- 代理用 `node:http` 的 `createHttpServer` + `httpRequest` 手写（**不用 `fetch`**
  —— 它会缓冲整个响应体，而 magpie 页面有大量并发资源请求）。
- **不能丢 `content-encoding` / `content-length`**：magpie 的响应是 gzip/br
  压缩的，丢了 `content-encoding` 浏览器就不解压，页面显示成一堆乱码。
- WebSocket 升级（`server.on('upgrade')`）要手工拼 `HTTP/1.1 101` 响应行再
  双向 `pipe`，否则 magpie 的实时通道静默失效（静态资源不受影响）。
- `magpie web` 用固定 `MAGPIE_WEB_KEY`（16+ 个 `[A-Za-z0-9._~-]`），否则每次
  运行 key 都变，iframe 的 `src` 跟着变，用户登录态每次都丢。
- 加 `--no-open`，否则 magpie 会调系统浏览器弹一个外部窗口。
- magpie 页面所有资源都是**相对路径**（`boot.js` / `app.css` / `plugins/*/*.js`），
  没有前导 `/`，所以代理**不需要**重写 HTML。
- **不设 `sandbox`** —— 原版页面依赖 `localStorage` 记住界面状态，加 sandbox
  会退回未登录。

## 开发

```bash
# 全量构建（tsc + 客户端 esbuild）
node scripts/build.mjs

# 单测（63 个）
node node_modules/vitest/vitest.mjs run

# 冒烟（真实网关）
node scripts/smoke.mjs

# 装配校验（检查 patch.yml 里每个 insert 能否加载）
node scripts/verify-profile.mjs --profile desktop
```

⚠️ **必须用 DSH 自带 node**（v24.21.0）：

```
D:/DSH/resources/runtime/primary-runtime/dependencies/node/bin/node.exe
```

PATH 里的 `D:\nodejs\node.exe`（v24.15.0）跑 vitest 会 `ERR_IPC_CHANNEL_CLOSED` 崩 worker。

## 坑

- **`Config` 必须是 schemastery schema**。传裸函数会抛 `TypeError: ... .toJSON is not a function`，让所有依赖 settings 的界面全挂。
- **`dsh.client.inject` 里不要静态列 `connection`** —— 它只由 Web bundle 提供，headless profile 里不存在，会让插件永久 pending。
- **`inject` 里缺任何一项，整条插件都不激活**。可选服务用 `ctx.inject([...], cb)` 而非静态 `inject`。
- **`exports["./client"]` 必须存在**，否则宿主找不到客户端 bundle，面板静默不出现。
- **包名改动要同时改 profile 的 `dependencies` 与 `dsh.profile.bundles`**，否则静默失效。
- **本地 `link:` 安装不跑 `prepare`**，必须先手动 `node scripts/build.mjs`。

## License

MIT
