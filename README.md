# dsh-magpie

把 [magpie](https://github.com/yetone/magpie) 本机模型网关接入 DeepSeek Harness 的插件。

- **Provider**：`magpie-direct` —— 网关上的全部模型自动出现在 DSH 的模型选择器里
- **面板**：侧边栏「Magpie」入口，iframe 嵌入 magpie 官方 Web UI

> **为什么 id 是 `magpie-direct` 而不是 `magpie`**：DSH 桌面版内置了
> `@deepseek-ai/dsh-llm-pi-ai`，它已经占用 provider id `magpie`，而且带一套自愈
> 逻辑（只要配置里找不到启用的 `llm-pi-ai` 条目，宿主就会在几十秒内把整段配置
> 追加回来）。同一个 provider id 只能挂一个 adapter —— 抢 `magpie` 会抛
> `DUPLICATE_ADAPTER`，整个 profile 启动失败。所以本插件用独立 id 与它**并存**。

## 前置条件

**没有前置条件 —— 装上就能用。**

插件会在第一次需要时自动把 magpie 二进制下到 `~/.dsh/magpie/bin/`：

```
[magpie] 未找到 magpie 二进制，自动下载中（首次约 69 MB）…
[magpie] 下载 magpie-cli-windows-amd64.exe（v0.1.3189）
[magpie] 下载中 17.3 MB / 69.5 MB（25%）
[magpie] 下载完成：C:\Users\你\.dsh\magpie\bin\magpie.exe（69.5 MB，sha256 3f2a…）
[magpie] 网关已就绪：http://127.0.0.1:3425（Web UI 代理 http://127.0.0.1:64808/）
```

### 二进制从哪来（四级回退）

插件按这个顺序找，**命中即停**：

| 顺序 | 位置 | 说明 |
| --- | --- | --- |
| 1 | 配置里的 `magpieBinary` | 显式指定绝对路径，优先级最高 |
| 2 | `~/.dsh/magpie/bin/magpie[.exe]` | 插件自己下的，跨 profile 共享 |
| 3 | 系统安装位置 | Windows `%LOCALAPPDATA%\Programs\magpie\`、macOS `/Applications/magpie.app/…`、Linux `~/.local/bin` 等 |
| 4 | `PATH` | 逐目录找 |

四级都没有、且 `autoDownloadMagpie: true`（默认），才走下载。

**为什么要自己下一份**：magpie 的桌面安装包**不会**把自己加进 `PATH`，
所以「用户装了 magpie 桌面版」和「插件能在 `spawn` 里找到它」是两件事。
第 3 级的系统安装位置就是为这个准备的 —— 你在 PATH 外装了 magpie，插件也能用上；
连装都没装才去下载。

### 关掉自动下载

公司网络挡了 GitHub、或者想自己管二进制：

```yaml
- id: magpie
  config:
    autoDownloadMagpie: false
    magpieBinary: /opt/magpie/magpie    # 指向已有的
```

### 预先下载（可选）

插件在第一次需要时会自动下，正常情况下不用管。想在 CI 镜像里预置、
或者先确认网络通不通：

```bash
npm run magpie:download            # 没有才下
npm run magpie:download -- --force # 强制重下
```

下载目标固定是 `~/.dsh/magpie/bin/magpie[.exe]`，跟插件运行时用的是**同一套
代码**（`src/download.ts` 的 `ensureMagpieBinary`），所以手动跑和自动跑结果
必然一致。想离线部署就把整个 `~/.dsh/magpie/` 目录打包带走。

### 网关由插件自动拉起

不需要事先手动开 magpie。插件加载时会起一个
`magpie serve --web=<port>` 进程，它**同时**提供网关和 Web UI：

```
● magpie gateway on http://127.0.0.1:3425
  OpenAI   http://127.0.0.1:3425/v1/chat/completions · …/v1/responses
  Anthropic http://127.0.0.1:3425/v1/messages
● magpie web on http://127.0.0.1:3480/?k=…
```

如果网关**已经在别的进程里跑**（比如你自己开着 magpie 桌面应用），`serve`
检测到端口被占只提供 Web UI（日志里是 `another magpie serves the gateway
there`），不会抢端口、也不会起第二个网关。

不想让插件管进程（比如网关跑在另一台机器上），把 `autoStartGateway` 关掉：

```yaml
- id: magpie
  config:
    autoStartGateway: false
    baseURL: http://192.168.1.10:3425
```

验证网关（插件启动后）：

```bash
curl -s -H "Authorization: Bearer magpie" http://127.0.0.1:3425/v1/models
```

## 安装

```bash
# 1. 克隆
git clone https://github.com/Betsy20/dsh-magpie.git
cd dsh-magpie

# 2. 装依赖（`prepare` 脚本会自动跑一次构建）
npm install

# 3. 装进 profile（把 <profile> 换成 desktop / web）
dsh plugin --profile <profile> install "$(pwd)"

# 4. 重启 DSH
```

> **`link:` 安装不会跑 `prepare`。** 如果第 2 步跳过了（比如直接 `dsh plugin
> install` 一个没装过依赖的目录），必须先手动 `node scripts/build.mjs`，
> 否则 `lib/index.js` 不存在，宿主会静默禁用插件。

`package.json` 的 `dsh.bundle.patch` 会指向 `cordis.patch.yml`，它往插件树里插一条：

```yaml
- insert:
    - id: magpie
      name: 'dsh-magpie'
```

## 仓库里有什么

**只放源码。** 任何「一条命令就能重新生成」的东西都不进版本库 —— 它们只会
让 diff 变吵、让 review 变瞎、让冲突变多。

### ✅ 会提交

| 路径 | 说明 |
| --- | --- |
| `src/**/*.ts` | 宿主侧 TypeScript 源码 |
| `plugin-src/client/**/*.js` | 客户端面板源码（esbuild 的输入） |
| `scripts/**/*.mjs` `scripts/**/*.ps1` | 构建 / 冒烟 / 装配校验 / 链接脚本 |
| `tests/**/*.spec.ts` | vitest 单测 |
| `package.json` `tsconfig.json` `vitest.config.ts` | 工程配置 |
| `cordis.patch.yml` | 插件树补丁（`dsh.bundle.patch` 指向它） |
| `README.md` `LICENSE` `.gitignore` `.gitattributes` | 文档与仓库规范 |

### ❌ 不提交（已在 `.gitignore` 里）

| 路径 | 为什么 |
| --- | --- |
| `lib/` | `node scripts/build.mjs` 的产物（tsc → 宿主侧，esbuild → `lib/client.js`）。提交它等于每次改源码都要手工同步一份编译结果，diff 里全是噪声 |
| `node_modules/` | `npm install` 重新生成 |
| `.env` `.env.*` | **含真实 key**（`MAGPIE_GATEWAY_KEY` / `MAGPIE_WEB_KEY`），泄露即等于把网关交给别人 |
| `*.log` `logs/` | 运行期日志，可能含 token / cookie / 本机绝对路径 |
| `*.tsbuildinfo` `dist/` `build/` `coverage/` | 构建缓存与测试产物 |
| `.vscode/*` `.idea/` | 个人 IDE 配置 |
| `.DS_Store` `Thumbs.db` `desktop.ini` | 操作系统垃圾文件 |
| `*.png`（`docs/screenshots/` 除外） | 调试期截图，体积大且无复用价值 |
| `*.tmp` `*.bak` `*.orig` `scratch/` `tmp/` | 临时文件 |

### 从仓库到能跑

```bash
git clone https://github.com/Betsy20/dsh-magpie.git && cd dsh-magpie
npm install          # 触发 prepare → 生成 lib/
node node_modules/vitest/vitest.mjs run    # 63 个单测
```

`lib/` 是**生成物**，不在仓库里 —— 这是刻意为之，保证「仓库里看到的」与
「实际跑的」永远一一对应。

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
| `autoStartGateway` | `true` | 插件加载时自动起 `magpie serve` 网关 |
| `autoDownloadMagpie` | `true` | 找不到 magpie 二进制时自动从 GitHub 下载（~69 MB） |
| `magpieBinary` | `magpie` | magpie 可执行文件路径（绝对路径优先） |
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
  gateway.ts      网关存活探测（/api/hello 轮询，避免把别人的 200 当成 magpie）
  binary.ts       magpie 二进制解析（配置 → 插件自带 → 系统安装 → PATH）
  download.ts     自动下载（GitHub Releases，`.part` + rename + sha256）
  web-bridge.ts   管理 magpie serve 子进程 + 反向代理（登录取 cookie、注入转发、WS 透传）
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

`ctx.llm.registerAdapter(['magpie-direct'], adapter)` —— 内部已 `ctx.effect`，插件卸载时自动注销。**不要再包一层** `ctx.effect`，否则二次释放会抛 `REGISTRATION_DISPOSED`。

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

### 网关自动启动

插件加载时（`apply()`）会在后台起一个 `magpie serve --web=<port>` 进程：

```
magpie serve --web=127.0.0.1:3480
  ├── 网关 on http://127.0.0.1:3425        ← 模型走这里
  └── Web UI on http://127.0.0.1:3480     ← 面板 iframe 走这里（再经反向代理）
```

**为什么是 `serve --web` 而不是 `web --addr`**：`magpie web` 要求**已经
有**一个 magpie 在服务网关；`magpie serve --web=` 是**一个进程同时提供
两者** —— 网关端口空闲时它自己服务，已被别的实例占用时它只提供 Web UI
（日志里那句 `another magpie serves the gateway there`）。两种情况下都恰好
是我们要的行为，不需要分支判断。

**为什么不等它就绪**：`apply()` 是同步的，cordis 等它返回才认为插件激活
完成。真等冷启动（实测 3–8 秒，插件多时十几秒）会拖慢 DSH 启动。所以后台
跑，成功/失败只写日志 —— 模型目录本身是惰性拉的，网关晚几秒就绪不影响
正确性。

**失败不抛**：二进制不在 `PATH`、端口全被占、被安全软件拦，都不应该让整个
插件失效（用户可能就是想连另一台机器上的网关）。降级成一条 `warn`。

**卸载时清理**：`ctx.effect(() => () => bridge.dispose())` 里 `taskkill /T /F`
连进程树一起收，否则 `magpie serve` 会变孤儿进程一直占端口。

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

### Windows 环境坑

- **PowerShell 5.1 的 `Get-Content` 默认按 ANSI(GBK) 解码**。`~/.dsh/magpie/bin/version.json`
  里的 `note` 字段是中文，`Get-Content -Raw | ConvertFrom-Json` 会把 UTF-8 的
  `97 22` 两字节合成一个汉字，然后报「传入了未终止的字符串」——
  **这是读取端的假故障，文件本身一直是对的**。读任何含中文的 UTF-8 文件都要显式
  `-Encoding UTF8`（或 `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)`）。
- **`curl` 的 schannel 后端对 GitHub Release 重定向会静默截断**（`schannel: server
  closed abruptly (missing close_notify)`，只下到 31–36 MB 就断，**退出码仍是 0**）。
  所以 `src/download.ts` 用 Node 的 `fetch`（undici）而不是 `curl`。
- **`cmd /c` 会吞掉批处理输出**（只回显 cmd banner），要用 `cmd //c`。
- **`.cmd` 文件里只能写 ASCII**：cmd 按 GBK 读 UTF-8，中文会乱码成
  `系统找不到指定的路径`。要传中文参数就直接在 Git Bash 里调 node。
- **`wmic` 在 Windows 11 已移除**。查进程改用
  `Get-Process -Name 'xxx'` 或 `Get-CimInstance Win32_Process`。
  （注意：`Get-CimInstance -Filter "Name='a b.exe'"` 在 Git Bash 里多层引号转义会
  报 `CimException HRESULT 0x80041017`，改用 `Where-Object` 更省事。）

## License

MIT
