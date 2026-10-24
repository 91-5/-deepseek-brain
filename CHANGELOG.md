# Changelog

本文件记录 deepseek-brain 的用户可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **图片输入支持**（DSB-20261024-011）。`messages[].content` 从 `string` 放宽为
  `string | ContentPart[]`，接受 OpenAI 三种多模态方言（`image_url` / `input_image` /
  `image`，依据 LiteLLM 的 `_IMAGE_CONTENT_PART_TYPES`）；其中 `image_url` 同时接受
  **对象与裸字符串**两种形态。图片解码后落盘为**绝对路径**临时文件（puppeteer 官方文档
  明确「连远端 Chrome 时 paths must be absolute」），再用 `uploadFile()` 上传到网页版的
  隐藏 `input[type="file"]`，等到输入区出现 `img[src^="blob:"]` 预览后才发送文本。
  新增 `src/server/multimodal.ts`；`selectors.json` 增 `fileInput` / `imagePreview`
  两个**可选**键，缺键走内置默认，老配置无需改动。

  **边界**：只支持 `data:` URI（远程 `http(s)` 明确 400，不发外部请求）；只上传当前轮
  user 消息的图片（历史附件不重传）；上传失败**一律抛 `upload_failed:` 并返回 502，
  绝不静默降级成纯文本**——那会让模型在没图时正常作答，产出通顺但完全错位的答案。

## [0.2.1] - 2026-10-04

### 修复

- **bridge 启动失败不再永久 502**（评审 COND-1）。此前 `launch()` 成功但 `openChatPage()`
  抛错时（网络抖动、DeepSeek 页面改版、会话文件损坏），`browser` 仍 connected 而 `page`
  为 null、或指向一个导航失败的坏页——`isBridgeAlive()` 为 true 让 `startBridge()` 永久早退，
  于是每个请求都撞 `bridge not started` 或等不到聊天输入框而 502，**永不重试，只能手动
  重启进程**；同时 `/health` 报 `bridge_idle`，让运维以为「再等等」而实际永远不会好。
  三处改动：①复用判据从「活着」收紧为「活着**且**有 page」（`openChatPage()` 里 `page`
  先赋值、`goto` 后执行，导航失败会留下非 null 的坏页，只判存活会漏掉这一路）；②`generate()`
  无条件 `await startBridge()`，复用决策只在 startBridge 内部做一处——判断散在两处就一定
  会漏掉一处；③启动失败时先**全量 teardown**（`close()` 带 3s 超时 + `taskkill /T /F`
  杀进程树 + 清闭包状态）再抛原始错误，状态因此坍缩回与冷启动一致，下个请求必然重试。
  teardown 必须真 close 而非只置 null：这种进程还活着，只置 null 会每次重试留下一个孤儿
  Chrome，而它们各持同一个 `.chrome-profile` 锁，几次之后 Chrome 就起不来了；close 必须
  带超时，因为 puppeteer 对已死连接的 `close()` 没有超时保证，挂住会永久占住单飞 promise
  `starting`，后续请求全 join 在一个永不 settle 的 promise 上——比原 bug 更糟。
  **未采纳评审建议的 `bridge_error` 新状态**：状态是给调用方做**分支决策**的（该等 / 该重试 /
  该登录），失败原因不是分支维度，新增状态值会破坏外部做 exhaustive switch 的消费者
  （OpenCode 等）。改为在 `bridge_idle` 的**可选**字段 `error` 里捎带最近一次失败原因——
  可选字段，老调用方的 `{status, loggedIn}` 形状不变，成功启动后清空。
  新增 `tests/bridge-start-failure.test.ts`（3 项）：以 `CHROME_PATH` 指向不存在路径制造
  启动失败，断言失败原因被捎带出来、状态不被污染成 `error`/`login_required`、后续请求仍走
  完整启动路径。**已知缺口（如实记录）**：这 3 项只覆盖「Chrome 探测失败」这一路；COND-1 的
  核心机理（`launch()` 成功但 `openChatPage()` 抛错，此时 browser 已 connected）**没有自动化
  覆盖**——要覆盖需给 `puppeteer-core` 注入假 browser，本仓目前没有该注入点，故该机理只有
  代码审查与人工推演支撑。评审时按 NOT_RUN 处理。
- **坏页路径现在有自动化守护**（评审 COND-2）。上一条修的是「`launch()` 成功但
  `openChatPage()` 抛错 → browser 活着但 page 是坏页 → 永久 502」，但**那条路一直没有
  测试**：生产启动链是「spawn 真 Chrome → 连 CDP 端口（最多重试 15×1s）→ openChatPage」，
  没有注入点就无法在 CI 里造出「已连接但不健康」这个状态。`WebBridgeOptions` 新增
  **仅测试用**的 `browserFactory`，整段替换掉第一段，而 `openChatPage` / `startBridge` /
  `teardownBridge` / `health` **一行不改**——测试跑的是真实组合，不是被单独调用的某个阶段。
  新增 `tests/bridge-badpage.test.ts`（3 项）：原错误透出、走 teardown 真关 browser 而非
  早退、下一次 `start()` 仍会重试。
  **这个测试证明什么、不证明什么写在文件顶部**，最要紧一条：注入路径下 `chromeProc`
  恒为 null，故 `taskkill` 杀进程树与 `close()` 的 3s 超时**都测不到**——「每次重试泄漏一个
  Chrome」这个最贵的风险仍无自动化覆盖，只能靠 live 门。该选项**不属包的公开 API**
  （`exports` 只有 `.` 与 `./core`），生产调用方不传时行为逐字不变。
  敏感性已实测：旧代码下这 3 项全红（护栏使它快速失败，不会真拉起 Chrome）。
- **`/health` 的 `error` 字段在出口截断**（评审 COND-3）。`bridge_idle` 的可选
  `error` 会捎带最近一次启动失败的原因，而原因里可能带本地路径、选择器名甚至带
  查询串的 URL；`/health` 是**无认证**的本地探针，完整回显等于把内部结构信息摊给
  任何能连上该端口的人。现在超过 200 字符的部分被裁掉并附 `…(+N chars)` 标记。
  **只在出口裁**：`lastStartError` 内存里保留全文，本地日志与排障不受影响——
  「内存留全文、对外给摘要」是两个不同需求，不该共用一个变量。评审把这条判为
  非阻塞（只监听 127.0.0.1），此处改成「默认就截断」，不依赖部署细节来兜底。
  **注意**：`…(+N chars)` 里的 `N` 会透露原始消息长度，从而暴露路径深度
  （`\` 分隔符个数即层级）。该字段仅 `127.0.0.1` 可达，若将来把 `/health` 暴露到
  其它地址，请重新评估这个提示。
- **Chrome 异常退出后 shim 能自愈**。此前 Chrome 崩溃、被用户关窗或休眠后被回收时，
  puppeteer 的 `browser` / `page` 对象都不会自动置 null——只是变成指向已死进程的
  陈旧句柄。于是 `startBridge()` 的 `if (browser) return` 一路早退、
  `if (!page) await startBridge()` 也判定为「已就绪」，shim 就此**永久砖化**：
  每个请求都 502，Chrome 再也不会被拉起，只能手动重启进程。早退条件改为
  `browser.isConnected()` 存活探测，断了就清理陈旧句柄后重新 launch。
  对「常驻后台服务」这个定位来说这是硬伤。
- `/health` 新增 `bridge_idle` 状态，区分「懒启动尚未拉起 Chrome」与「页面在但
  确实未登录」。此前懒启动下 health 在 `page` 为 null 时一律返回
  `login_required`，把两种处置方式完全不同的处境压成同一信号：运维探针无法
  分辨该等待/重试还是该去登录，只能一律按账号掉线处理。Chrome 异常退出时同样
  报 `bridge_idle` 而非 `error`，因为那同样是「bridge 不可用」而非「页面读取失败」。
  `loggedIn` 语义不变，`bridge_idle` 下仍为 `false`（bridge 不可用时确实无从得知
  登录态）。懒启动契约不变：`/health` 依然不触发 Chrome 启动。

### 新增

- `scripts\start-shim.cmd`：幂等启动器。端口已在监听则直接退出、不起第二实例
  （两个 node 进程共用一个 `.chrome-profile` 会撞 Chromium profile 锁）；
  探测失败时拒绝盲启而非猜端口状态；日志按日期追加；启动后轮询 `/health` 至多 30s
  再退出，node 进程脱离脚本继续存活。
- `scripts\install-autostart.ps1`：登录自启注册器，默认 dry-run。两种方式：
  - `-Method Registry`（默认）：写 `HKCU\...\Run`，**无需管理员**。
  - `-Method ScheduledTask`：`schtasks /create`，需管理员（实测非提权会返回「拒绝
    访问」）。保留 `ONLOGON` + `/it` + `/rl limited`，用 `ProcessStartInfo.Arguments`
    手工拼整条命令行以绕开 PS 5.1 原生命令参数绑定把 `/TR` 打碎的问题。
- `.gitattributes` 增加 `*.cmd text eol=crlf`：全局 `eol=lf` 会在 checkout 时把
  `.cmd` 打回 LF，cmd.exe 的行解析在 label/goto 处会出异常。

### 变更（平台支持）

- **不再硬性拒绝非 Windows 平台安装**，并如实分级声明验证程度。此前 `package.json`
  声明 `os: ["win32"]`，非 Windows 平台直接安装失败；Chrome 探测表也只有 6 条
  Windows 硬编码路径，函数名 `windowsChromeCandidates` / `detectWindowsChrome`
  直接把平台假设编进了标识符。项目的核心价值（把 DeepSeek 网页版包成 OpenAI
  兼容 API）与平台无关，这个限制是范围决定而非技术必然。
  - Chrome 探测改造为按平台分派：Windows 保留原有 6 条并补 `ProgramW6432`；
    macOS 4 条；Linux 2 条固定路径 + 按 PATH 扫描（`google-chrome-stable` →
    `google-chrome` → `chromium-browser` → `chromium`）。
  - 探测原语由 `existsSync` 改为 `accessSync(X_OK)`：三平台通用，Unix 校验可
    执行位，Windows 退化为 `F_OK`（Node 官方行为）。
  - 旧名 `windowsChromeCandidates` / `detectWindowsChrome` **彻底删除**，不保留
    薄封装——否则非 Windows 用户在启动失败时仍会看到指向 Windows 的候选路径。
  - `--chrome-path` 显式值现在与自动探测**共用同一套校验**：此前显式值被直接
    信任、跳过探测，不存在的路径能通过 CLI 早检查却在 bridge 启动阶段才失败，
    形成「CLI 说存在、bridge 说不存在」的两条真相。
  - **诚实分级，不宣称"全平台支持"**：Windows 为 Tier 1（已实测）；桌面
    Linux/macOS 为 Tier 2（代码路径已存在但**无真机验证**）；headless / Docker /
    WSL 为 Tier 3（**不承诺**——首次人工登录需要真实图形显示，headless 环境
    物理上跑不通首登流程）。`package.json` description、README、`--help` 文本
    三处声明保持一致。
  - **未实现**：snap / flatpak 路径探测（四家成熟项目 puppeteer、
    chrome-launcher、karma-chrome-launcher、playwright 均未做，无先例可循）；
    无条件注入 `--no-sandbox`（puppeteer 官方明确 "strongly discouraged"）；
    自带 Chromium 下载逻辑（会引入 Gatekeeper / 签名问题）。

## [0.2.0]

首个公开发布版本。相比 0.1.0 的核心变化是把项目从「私有 shim」改造成**可复用、可安装的库**。

### 新增

- `deepseek-brain/core` 子路径导出：`SessionStore`、`SessionKeyStrategy`、
  `PlannerDeps` 三个替换边界公开，第三方可接管会话存储、会话 key 派生与
  compaction 阈值，无需改动 core 内部。
- `Transport.cancel()`：中止进行中的生成；无进行中生成时为空操作。
- `Transport.getCapabilities()`：回报 `supportsThinking` / `supportsResume` /
  `maxContextTokens`，让第三方 transport 能如实描述自己的能力。
- `deepseek-brain login` 子命令：只走登录流程，成功后退出、不监听端口。
- 首次运行阻塞登录：未检测到登录态时启动阶段阻塞等待，登录完成后才开始
  监听端口，避免客户端拿到一个必然失败的端口。
- 完整 CLI 参数面：`--port` / `--profile` / `--chrome-path` / `--headless` /
  `--verbose` 与 `serve` / `login` 子命令，坏值一律报错而非静默降级。
  - `--verbose` 有实际作用：等价 `LOG_LEVEL=debug`，打开三处会话恢复诊断
    （恢复的 chatSessionId / 恢复目标被重定向 / 恢复导航失败）。此前 `LOG_LEVEL`
    只有一个写入方、零个读取方，该 flag 形同虚设。
- `LOG_LEVEL` 环境变量现在真的被读取（此前无人读，`log.level` 恒为 `info`）。
- Chrome 路径自动探测：装在标准位置时无需任何配置；探测不到会在启动早期
  直接失败并列出候选路径，而不是等首个请求超时。
- compaction 阈值注入：`deps.threshold` > `COMPACT_THRESHOLD` 环境变量 > 默认
  40000（估算 token 数）。详见 `src/core/planner.ts`。
- 条件导出（`types` + `default`）与显式 `"./package.json"`，TypeScript 消费方
  与 vite 等 bundler 均可正确解析。
- 可安装的 `bin`：`npx deepseek-brain` 可直接运行。

### 修复

- 修正 README 安装命令中的仓库名：`npm install -g github:91-5/-deepseek-brain#v0.2.0`
  指向一个只短暂存在过的仓库名，照抄会 404。正确为 `github:91-5/deepseek-brain#v0.2.0`。
  同段「仓库名含前导连字符是刻意的」一句已随改名删除。

### 变更

- 内部重构为三层（`core` / `transports` / `server`）。`core` 为纯逻辑层，
  不依赖 `transports` 与 `puppeteer-core`。
- **Windows only**：`package.json` 声明 `os: ["win32"]`，其他平台安装即被拒绝，
  不再「装得上但跑不了」。
- 会话存储接口化，同时**保持 `.sessions.json` 落盘格式不变**。
- `health()` 从裸字符串改为 `{ status, loggedIn }` 对象：只有 status 分不清
  「没登录」与「页面还没加载出来」，而这两者的正确处置完全不同。
- 登录态判据从「页面是否渲染」改为「profile 里有没有 Cookies 文件」，
  因此 Chrome **懒启动**：profile 已播种时端口先开、首个 `/v1/chat/completions`
  请求才拉起 Chrome（可复现原行为：删掉 profile 或先跑 `deepseek-brain login`）。
- PROBE 响应改为带 `startsWith` 守卫的增量合并，长回答不再每 400ms 重解析整份
  SSE 流（原为 O(N²)）；SSE 消费同样改为增量，分片与整份解析逐步等价。
- `puppeteer-core` 依赖改为精确版本固定。

### 移除

- **破坏性**：删除把作者个人 Nuphus 浏览器 profile 复制为登录态的机制。
  旧版本靠「复制一份现成的浏览器 profile」免登录，新版本一律要求用户在自己
  的 Chrome 里亲手登录。升级后请先跑 `deepseek-brain login`。
- **破坏性**：删除硬编码的个人 Chrome 路径，改为标准位置自动探测 +
  `CHROME_PATH` / `--chrome-path` 覆盖。
- `--pool-size` 在发布前移除（从未实现，避免帮助文本虚假承诺）。该版本从未
  发布过，升级者不存在依赖；现在传入它会被当作未知 flag 忽略。

### 兼容性

- **`.sessions.json` 格式未变**，0.1.0 产生的会话文件可直接沿用。
- 会话 key 算法未变（`prefixHashStrategy` 委托既有 `computeSessionKey`），
  升级后历史会话不会失配。
- compaction 触发阈值未变（仍为 40000）。
- 监听地址与路由未变（`127.0.0.1` + `/v1/models`、`/v1/chat/completions`）。

## 0.1.0

初始内部版本。

- DeepSeek 网页版 → OpenAI 兼容 HTTP 接口的 shim。
- WebBridge 封装 puppeteer-core 会话恢复、选择器点击与 DOM 文本抓取。
- 工具调用协议解析与格式重试。

[0.2.1]: https://github.com/91-5/deepseek-brain/releases/tag/v0.2.1
[0.2.0]: https://github.com/91-5/deepseek-brain/releases/tag/v0.2.0