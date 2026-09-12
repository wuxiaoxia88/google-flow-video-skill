# FlowBridge：Google Flow Codex Skill 开发方案与产品需求文档

**文档状态**：v1.2，可进入受控 M0；首次 Credits 点击前须通过本文件的 M0 付费安全门槛  
**版本**：v1.1  
**基准日期**：2026-09-05  
**目标运行方式**：本地 Codex CLI、Codex 桌面端或 IDE 扩展，运行机器同时具备可视化 Chrome 浏览器  
**项目代号**：`flow-bridge`  
**Skill 名称**：`google-flow-video`

---

## 1. 项目摘要

FlowBridge 将 Google Flow 网页端封装成一套稳定、可审计、可被 Codex 调用的本地视频生成接口。用户以自然语言描述视频，Codex Skill 负责澄清和结构化需求，本地服务负责打开用户自己的 Google Flow 登录会话、配置模型和参数、上传参考素材、提交任务、等待生成、下载结果，并返回视频路径与完整元数据。

目标体验：

```text
用户：用这张产品图生成一个 9:16、8 秒、720p 的广告视频，使用 Omni，最多消耗 50 Credits，生成后下载到桌面。

Codex Skill：
1. 校验输入文件与模型能力
2. 查询 Flow 当前可用模型、参数和积分
3. 估算本次积分成本
4. 调用本地 FlowBridge
5. 跟踪任务状态
6. 下载视频并校验文件
7. 返回本地路径、实际模型、积分变化和 Flow 项目链接
```

该项目不依赖 OpenClaw。Codex 可以直接通过 CLI 调用，也可以在后续版本通过 MCP 工具调用。

---

## 2. 需求理解

### 2.1 用户真正希望解决的问题

Google Flow 已经具备强大的视频生成能力，但网页操作需要反复完成创建项目、切换视频模式、选择模型、设置比例和时长、上传素材、提交生成、等待、打开资产菜单、选择下载等步骤。重复操作造成时间浪费，也难以嵌入自动化内容生产流程。

用户希望获得类似 HeyGen API 的调用体验：

1. 使用一句自然语言或一个结构化请求提交视频任务。
2. 使用用户自己的 Google 账号、订阅权益和 Flow Credits。
3. 支持文本、首帧、首尾帧、Ingredients 或 References 等输入方式。
4. 自动完成生成、状态查询和下载。
5. 可以从 Codex Skill、CLI、MCP 或本地 REST API 调用。
6. 对积分消耗、重复提交、账号安全和 UI 变化有明确保护。
7. 将来 Google 开放 Flow API 时，可以平滑替换底层实现。

### 2.2 名称校正与当前能力基线

用户提到的“Vue 3.0”应为 Veo。以 2026-09-05 的 Google 官方文档为基准，Flow 当前主要视频模型包括：

- Gemini Omni Flash 1.1
- Veo 3.1 Lite
- Veo 3.1 Fast
- Veo 3.1 Quality

Flow 支持文本生成视频、首帧生成、首尾帧生成、Ingredients 或 References、部分视频编辑、扩展和分辨率升级。具体能力会随模型、地区、订阅等级和产品更新变化。

### 2.3 关键事实

截至本需求文档编写日期：

1. Google 已经为 Gemini Omni Flash 与 Veo 3.1 提供 Gemini API。
2. Gemini API 使用开发者项目和 API 计费体系。
3. Flow 网页端使用 Flow Credits 或账户 AI Credits，并保留 Flow 项目、素材库、编辑栈和网页特有功能。
4. 尚未发现 Google 官方公开的 Flow 项目、Flow Credits、Flow 资产与下载相关 API 或 MCP 文档。
5. 希望消耗 Flow 订阅积分时，MVP 默认通过 Codex 支持的浏览器工具复用用户当前已打开、已登录的 Flow 标签页；独立 CLI 通过本机 executor ticket bridge 请求操作，不能假定自己自动取得 Codex 浏览器句柄。稳定提交、结果匹配和下载仍待 M0 实测。

因此，产品应支持两种 Provider：

- `flow_ui`：首要模式。使用 Flow 网页和用户订阅积分。
- `gemini_api`：可选模式。使用官方 Gemini API，适合稳定的服务器化调用和规模化生产。

两种 Provider 对外复用统一任务骨架，但保留 Provider 特定的能力、模型标识、计费来源、单位和预算字段；Gemini API Provider 及其币种预算契约属于 M6 后续范围。

---

## 3. 第一性原理与产品决策

### 3.1 Skill 不能单独承担全部工作

Skill 擅长识别用户意图、补全参数、执行标准流程、解释结果。浏览器点击、任务去重、积分保护、文件下载和故障恢复需要确定性程序。把每次网页操作都交给大模型视觉点击，会带来较高 Token 消耗、较慢速度和难以复现的失败。

产品采用三层结构：

1. **Codex Skill**：自然语言入口和流程编排。
2. **FlowBridge 本地服务**：任务、状态、积分、文件与安全控制。
3. **Playwright Flow Adapter**：浏览器确定性执行。

### 3.2 订阅会话必须留在用户设备

Flow 订阅积分绑定用户 Google 账号。MVP 默认复用用户现有 Chrome 中已经登录的 Flow 标签页，但只能通过 Codex 支持的现有浏览器连接操作；程序不读取或转移密码、Cookie、Token 或 Profile，也不接管两步验证。专用 Profile 仅保留为明确 opt-in 的兼容测试路径。

### 3.3 UI 是变化中的外部依赖

Flow 的功能、模型、成本和 DOM 结构都可能变化。程序必须把“能力发现”设计成核心能力，不能把模型组合和页面选择器永久写死。

### 3.4 积分点击属于有成本操作

点击 Generate 可能立即产生积分消耗。系统必须具备成本预估、50 Credits 全任务硬限、当前对话授权判定、幂等键、提交确认和“状态不明确时停止重试”的机制。

### 3.5 对外契约保持稳定

无论底层采用 Flow UI、Gemini API，或未来官方 Flow API，上层调用形式保持一致。Provider 层承担差异转换。

---

## 4. 产品定位

### 4.1 一句话定位

FlowBridge 是一个在用户本机运行的 Google Flow 自动化网关，让 Codex 和其他本地应用能够通过统一接口完成视频生成、跟踪与下载。

### 4.2 MVP 目标用户

- 已经订阅 Google AI Plus、Pro 或 Ultra 的个人创作者。
- 经常使用 Flow 生成短视频的运营人员。
- 希望用 Codex 批量整理提示词和调用 Flow 的开发者。
- 需要把 AI 视频嵌入内容流水线的中小团队。

### 4.3 MVP 运行边界

- 首先支持 macOS 和 Windows。
- 首先支持单机、单用户、单 Google 账号 Profile。
- 首先支持本地 Codex 环境。
- 默认使用可视化浏览器，方便用户观察并在必要时接管。
- 每个账号默认只允许一个消耗积分的任务同时提交。

### 4.4 暂不纳入 MVP

- 保存 Google 用户名、密码或两步验证密钥。
- 共享账号池与集中托管账号。
- 自动处理验证码或绕过安全检查。
- 调用、重放或逆向 Flow 私有接口。
- 自动购买 Credits。
- 公网无认证 REST 服务。
- 多租户 SaaS。
- 大规模账号轮换、代理池、规避限流或地区限制。
- 在 Codex 云端直接接管用户本地日常 Chrome Profile。

---

## 5. 总体架构

```text
┌───────────────────────────────────────────────────────────┐
│ 用户                                                      │
│ 自然语言、图片、视频、参数、积分上限                      │
└──────────────────────────┬────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────┐
│ Codex Skill: google-flow-video                            │
│ 需求解析、缺省值、风险确认、调用 flowctl、结果解释         │
└──────────────────────────┬────────────────────────────────┘
                           │ CLI JSON 或 MCP
┌──────────────────────────▼────────────────────────────────┐
│ flowctl                                                   │
│ 人类可用命令行，稳定 JSON 输出                            │
└──────────────────────────┬────────────────────────────────┘
                           │ localhost HTTP
┌──────────────────────────▼────────────────────────────────┐
│ flowd                                                     │
│ Fastify 本地服务、任务队列、SQLite、策略、审计、下载管理  │
└───────────────┬───────────────────────────┬───────────────┘
                │                           │
┌───────────────▼──────────────┐  ┌─────────▼───────────────┐
│ FlowUiProvider              │  │ GeminiApiProvider       │
│ Codex existing-tab executor │  │ 官方 Gemini API，可选   │
└───────────────┬──────────────┘  └─────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────┐
│ Google Flow 网页端                                        │
│ 用户账号、Flow Credits、项目、素材、生成与下载            │
└───────────────────────────────────────────────────────────┘
```

### 5.1 组件职责

#### `google-flow-video` Skill

- 将自然语言转换成标准 `VideoGenerationRequest`。
- 检查输入路径、模型、比例、时长、输出数量和积分上限。
- 调用 `flowctl capabilities` 和 `flowctl credits`。
- 在高成本或能力不明确时请求用户确认。
- 调用生成命令并解析 JSON 结果。
- 返回可操作的错误和文件路径。

#### `flowctl`

- 为用户和 Codex 提供稳定命令。
- 所有命令支持 `--json`。
- 退出码可被 Codex 和自动化程序可靠判断。
- 自动发现或启动本地 `flowd`。

#### `flowd`

- 监听 `127.0.0.1`。
- 管理任务状态机、队列、幂等、积分策略和文件归档。
- 保存 SQLite 状态。
- 调用 Provider。
- 输出结构化日志和故障诊断包。

#### `FlowUiProvider`

- 通过 Codex 已连接的现有 Flow 标签页执行受控 readback；独立 CLI 不启动浏览器或取得日常 Chrome 句柄。
- 检查登录、地区、订阅和当前积分。
- 发现当前可用模型与参数。
- 创建或打开 Flow 项目。
- 配置输入、模型、比例、时长、数量和分辨率。
- 上传素材。
- 提交任务并识别新生成的资产。
- 下载并返回文件。

#### `GeminiApiProvider`

- 使用官方 Gemini API。
- 将统一请求映射到 Gemini Omni 或 Veo 参数。
- 轮询长任务并下载结果。
- 作为未来服务器模式和故障降级选项。

---

## 6. 技术选型

### 6.1 推荐技术栈

- 语言：TypeScript
- 运行时：当前 Node.js LTS
- 浏览器自动化：Playwright
- 本地 HTTP：Fastify
- 参数校验：Zod + JSON Schema
- 数据库：SQLite，推荐 `better-sqlite3`
- 日志：Pino，启用字段脱敏
- 测试：Vitest + Playwright Test
- 视频校验：真实生成/下载路径必需可靠媒体探测器（推荐 `ffprobe`）与完整解码器（推荐 `ffmpeg`）；纯 dry-run 可选
- 包管理：pnpm
- 发布：单仓库 Monorepo

### 6.2 浏览器运行与 executor ticket 策略

约束：

- 默认 `existing_browser` 仅复用 Codex 支持的浏览器工具已经连接的、当前已登录 Flow 标签页；必须校验实现中明确允许的官方 Flow origin、当前项目 URL、tab/session 身份和请求绑定。
- 独立 `flowctl` 不能直接调用 Codex CUA 或假定自动连接，必须通过本机 executor ticket bridge；没有执行器时返回 `EXISTING_SESSION_REQUIRED`。
- 提交流程固定为：页面 observation → core 验证 → intent 原子落盘 → one-shot ticket → 最终配置/总价/余额读回与一次点击 → receipt。已有 intent 时 ticket 必须设置 `Generate=false`，只允许观察、对账、跟踪和下载。
- 禁止另起进程以 persistent context 打开用户日常 Chrome `User Data`，禁止复制 Cookie、Token 或 Profile，禁止暗开调试端口、重启浏览器或安装扩展。
- disconnect 只释放 FlowBridge 连接，不得关闭用户浏览器或原标签页；连接中断不得新建 Profile 或重新提交。
- 专用 Profile 只保留为明确 opt-in 的兼容测试方式，并继续使用独占锁；不得回退成默认路径。
- 日志与诊断不记录完整邮箱或页面中已有 Prompt。

### 6.3 选择器策略

优先级：

1. `getByRole`
2. `getByLabel`
3. `getByText`，使用受控多语言词典
4. 稳定的 `data-*` 属性
5. 局部 DOM 结构

禁止长期依赖：

- 自动生成的 CSS 类名
- 深层 CSS 路径
- 绝对 XPath
- 屏幕坐标点击

每个页面实现 Page Object：

- `FlowHomePage`
- `FlowProjectPage`
- `GenerationSettingsPanel`
- `AssetGrid`
- `AccountCreditsPanel`
- `DownloadMenu`

### 6.4 页面能力快照

每次新会话或缓存过期后运行 `capabilities refresh`。快照必须表达经过页面验证的有效组合或约束，不能将独立数组误作任意笛卡尔积：

```json
{
  "captured_at": "2026-09-05T02:00:00Z",
  "account_tier": "pro",
  "region": "SG",
  "models": {
    "omni-flash-1.1": {"valid_combinations": [
      {"mode":"text_to_video","durations":[4,6,8,10],"resolutions":["360p","720p"],"aspect_ratios":["16:9","9:16"],"input_constraints":{"images":0},"tier":"pro"}
    ]}
  },
  "ui_fingerprint": "sha256:..."
}
```

能力判断顺序：

1. 当前页面可见选项。
2. 最近一次缓存快照。
3. 内置官方文档基线。

页面显示与静态基线冲突时，以页面显示为准并写入 warning。缓存和静态基线只用于规划与诊断，不能授权付费点击；每次真实提交必须在已配置页面重新读回有效组合和成本。

---

## 7. 功能需求

### FR-001 初始化与运行环境检查

`flowctl doctor` 必须检查：

- Node.js 与依赖是否可用。
- Chrome 是否存在。
- Profile 目录权限。
- 下载目录是否可写。
- `flowd` 端口是否可用。
- SQLite 是否可创建。
- 真实生成/下载模式检查 `ffprobe` 与 `ffmpeg` 是否可用；缺失则阻止真实提交，纯 dry-run 仅告警。
- Flow 页面是否能访问。
- 是否检测到 VPN、代理配置或网络异常提示。

输出：

```json
{
  "ok": false,
  "checks": [
    {"name": "chrome", "status": "ok"},
    {"name": "flow_session", "status": "auth_required"}
  ]
}
```

### FR-002 现有浏览器会话

要求：

- 默认只使用 Codex 支持的浏览器工具已连接的当前 Flow 标签页，不新增或切换业务账号。
- CLI/REST 通过本机 executor ticket bridge 请求 observation 或动作；无连接时返回 `EXISTING_SESSION_REQUIRED`，不得自动打开浏览器或新建 Profile。
- 每次绑定核对 Flow origin 与当前 tab/session；executor receipt 只保留完成核验所需的脱敏证据。
- disconnect 不关闭用户浏览器或原标签页。连接中断后保留原 job/intent；已有 intent 禁止再次 Generate。
- 日志不得包含 Cookie、Authorization、Google 密码、完整邮箱或标签页原有 Prompt。

### FR-003 账户与积分读取

命令：

```bash
flowctl account --json
flowctl credits --json
```

返回：

- 账号脱敏标识。
- 订阅等级，如果页面可见。
- 当前 Credits。
- 下次刷新信息，如果页面可见。
- 数据来源与采集时间。

若无法可靠读取，返回 `unknown`，不能猜测。

### FR-004 能力发现

命令：

```bash
flowctl capabilities --json
flowctl capabilities refresh --json
```

要求：

- 枚举当前可用模型。
- 枚举每个模型支持的模式、时长、比例、分辨率、输出数量和升级选项。
- 枚举页面显示的积分成本。
- 保留地区或账号限制说明。
- 对未知选项保存原始可见文本，方便后续适配。

### FR-005 项目管理

MVP 支持：

- 按名称创建项目。
- 按精确名称复用已有项目。
- 以项目 URL 或内部本地映射打开项目。
- 默认命名：`FlowBridge-YYYY-MM-DD`。
- 保存本地 `project_id`、Flow URL、显示名称和最近访问时间。

同名项目存在多个时，返回候选列表，禁止随机选择。

### FR-006 文本生成视频

输入：

- Prompt
- 模型
- 比例
- 时长
- 分辨率
- 输出数量
- 项目
- 积分策略

最小调用：

```bash
flowctl generate \
  --prompt "A parcel travels through a futuristic sorting center" \
  --model omni-flash-1.1 \
  --ratio 9:16 \
  --duration 8 \
  --resolution 720p \
  --outputs 1 \
  --wait \
  --json
```

### FR-007 首帧与首尾帧生成

支持：

- `first_frame_to_video`
- `first_last_frames_to_video`

要求：

- 输入必须是本地绝对路径。
- 上传前验证文件存在、MIME、大小和像素尺寸。
- 自动等待上传完成。
- 首帧与尾帧不得错位。
- 页面缩略图出现后再进入提交阶段。

### FR-008 Ingredients 或 References 生成

支持多个图片或其他页面允许的素材。

要求：

- 保留素材顺序与可选别名。
- 上传失败时不得点击 Generate。
- 根据动态能力判断模型和时长组合。
- 对 Veo 的 8 秒限制和 Omni 的多时长支持进行预校验。

### FR-009 提示词规范化

Skill 允许两种模式：

- `verbatim`：严格原样提交用户 Prompt；除传输编码外不得增删、改写或翻译。
- `enhance`：按主题、动作、环境、镜头、灯光、风格、音频和限制补全 Prompt。

默认规则：

- 用户已经提供完整专业 Prompt 时使用 `verbatim`。
- 用户只给简单意图时使用 `enhance`。
- Skill 返回最终提交 Prompt 摘要，并在任务内保存不可变 `final_prompt` 与 `final_prompt_sha256`；公开 sidecar 默认只写哈希。
- 任何涉及人物肖像、商标、隐私或敏感内容的提示必须提醒用户遵守平台政策。

### FR-010 积分成本预估

系统维护两套数据：

- 静态官方基线。
- 当前 UI 实时成本。

基线示例：

| 模型与类型 | 单次生成基线成本 |
|---|---:|
| Veo 3.1 Lite，非 Ultra | 10 Credits |
| Veo 3.1 Fast，非 Ultra | 50 Credits |
| Veo 3.1 Quality | 100 Credits |
| Omni 720p，4/6/8/10 秒 | 7/10/12/15 Credits |
| Omni 360p，4/6/8/10 秒 | 4/5/6/7 Credits |
| Omni 视频编辑 | 40 Credits |
| 4K 升级，Ultra | 50 Credits |

全任务总成本估算（同一 job 的全部输出和升级费用累计并保留预算，不得将子动作分别与 20 比较）：

```text
estimated_credits = cost_per_generation × outputs + upscale_cost × outputs
```

页面成本未知或静态与动态不一致时：

- 标记 `cost_confidence = low`。
- 停止自动提交；未知成本不能证明满足 50 Credits 硬限。
- 记录页面截图与可见成本文本。

### FR-011 成本审批策略

默认配置：

```yaml
cost_policy:
  max_credits_per_job: 20
  confirm_above: 20
  reject_when_unknown: true
  confirm_multiple_outputs: true
  auto_purchase_credits: false
```

规则：

- `max_credits_per_job` 是不可突破的全任务硬上限，`confirm_above` 固定为同一数值 20；审批不得抬升该上限。
- 用户在当前任务或对话中明确发起生成，且页面实时可见的全任务总价不高于 50 Credits，可直接执行；多输出或升级若已明确授权且总价不超过 20，不重复请求确认。
- 总价超过 20 返回 `COST_LIMIT_EXCEEDED`，不创建可继续提交的审批，不点击 Generate。Veo Quality 100、4K 50 等高于上限的组合因此在 MVP 中拒绝。
- 页面成本未知、不可读或不能确认全任务总价不超过 20 时停止，不提交；用户确认未知风险也不能解除硬上限，因为平台金额无法由 FlowBridge 锁定。
- 必要澄清复用当前任务或对话，不建立独立审批请求、nonce 收据或审批版本流，也不要求用户为审批再次登录。
- Credits 不足时停止在提交前。
- 自动购买 Credits 永久关闭，除非未来单独设计并经过安全审核。

### FR-012 幂等与重复扣费保护

请求必须支持 `idempotency_key`。

规则：

- 同一 Key 与同一请求哈希在保留期内只提交一次。MVP 不自动清理幂等 tombstone；诊断资料 7 天 TTL 不得删除 jobs、submission attempts、请求哈希或去重状态。
- 已完成任务直接返回原结果。
- 正在运行的任务返回现有 `job_id`。
- Key 相同但请求内容不同，返回 `IDEMPOTENCY_CONFLICT`。
- 作用域为当前 Provider、executor 所绑定的当前 Flow tab/session 脱敏上下文与 Key；数据库建立唯一约束，并以单事务 insert-or-return。
- 请求哈希采用确定性规范化：展开默认值、稳定字段顺序与 Unicode；包含 `final_prompt_sha256`、模型/模式/参数、项目、输出、成本策略以及全部素材内容 SHA-256。
- 素材在排队或等待用户澄清前计算内容哈希，提交前复核；路径相同但内容变化视为请求冲突。
- CLI 自动生成 Key 时，必须在任何 Provider 副作用前持久化并输出 Key/job id；超时或重启只允许按原 job 恢复，不能生成新 Key 重新提交。

提交前保存：

- 项目 URL。
- 资产数量或可见资产标识。
- 当前积分。
- Prompt 哈希。
- 设置摘要。
- 页面截图。

点击 Generate 后必须确认以下任一证据：

- 新生成占位卡出现。
- 资产数量增加。
- 页面显示任务进行中状态。
- 项目时间线出现与当前任务匹配的条目。

点击 Generate 前，必须以事务落盘不可变请求哈希、素材哈希、可见账号上下文、实时参数/成本快照、提交前资产基线、唯一 `attempt_id`、fencing token 和 `state=SUBMITTING`。点击后页面崩溃、超时或结果不明确时进入 `SUBMISSION_UNCERTAIN`。从 `SUBMITTING` 或 `SUBMISSION_UNCERTAIN` 重启只能只读对账，禁止自动再次点击；找不到唯一结果时暂停当前 job 并提示人工裁决。

### FR-013 任务状态机

```text
CREATED
  -> VALIDATING
  -> AWAITING_CLARIFICATION | QUEUED
  -> STARTING_BROWSER
  -> AUTH_REQUIRED | CONFIGURING
  -> READY_TO_SUBMIT
  -> SUBMITTING
  -> GENERATING | SUBMISSION_UNCERTAIN
  -> GENERATED
  -> DOWNLOADING
  -> COMPLETED

PAUSED_FOR_HUMAN（尚无 submission intent） -> VALIDATING（resume 后重验页面、账号上下文、配置与资产基线）
PAUSED_FOR_HUMAN（已有 submission intent） -> SUBMISSION_UNCERTAIN | GENERATING | GENERATED | DOWNLOADING（resume 只允许对账、跟踪或下载，绝不回到可再次提交路径）
SUBMITTING -> GENERATING | SUBMISSION_UNCERTAIN
SUBMISSION_UNCERTAIN -> GENERATED | PAUSED_FOR_HUMAN
GENERATING -> RESULT_AMBIGUOUS（仅当页面已显示生成完成或超时对账结束后，候选仍为 0 个或多组；正常生成期候选为 0 时继续轮询）
RESULT_AMBIGUOUS -> GENERATED（仅人工选择并记录唯一证据后） | FAILED
GENERATED -> DOWNLOADING -> COMPLETED | PARTIALLY_COMPLETED
DOWNLOADING -> DOWNLOAD_FAILED -> DOWNLOADING（只重试下载）
提交前可终止为 CANCELLED_PRE_SUBMIT；提交后本地取消为 LOCAL_WAIT_CANCELLED_PROVIDER_CONTINUES。
终态：COMPLETED、PARTIALLY_COMPLETED、FAILED、CANCELLED_PRE_SUBMIT、LOCAL_WAIT_CANCELLED_PROVIDER_CONTINUES。
```

M0 必须直接实现以下关键迁移守卫；`Generate=false` 是禁止触发点击副作用的硬断言：

| Source | Event | Guard | Target | Side effect | Restart |
|---|---|---|---|---|---|
| `READY_TO_SUBMIT` | `submit` | 当前对话已授权；实时组合有效；全 job 总价已知且 ≤20；无既存 intent；持有最新 fencing token | `SUBMITTING` | 单事务写入 intent、快照、attempt 与 token，提交事务后才允许 Generate 一次 | 若 intent 已存在，`Generate=false`，转只读对账 |
| `READY_TO_SUBMIT` | 点击前崩溃 | intent 事务未提交 | `READY_TO_SUBMIT` | 无 Provider 副作用 | 重新验证全部 guard 后才可创建 intent；旧 token 作废 |
| `SUBMITTING` | 点击后崩溃或响应丢失 | intent 已持久化，是否提交未知 | `SUBMISSION_UNCERTAIN` | `Generate=false`，只读扫描当前项目 | 重启继续对账，绝不回到 `READY_TO_SUBMIT` |
| `PAUSED_FOR_HUMAN` / 任意恢复态 | `resume` | intent 已存在 | `SUBMISSION_UNCERTAIN`、`GENERATING`、`GENERATED` 或 `DOWNLOADING` | `Generate=false`；只允许对账、跟踪、唯一归因或下载 | 每次重启沿 intent 状态恢复，不能创建新 attempt |
| `GENERATING` | poll 返回 0 候选 | 页面仍生成中且未超时 | `GENERATING` | 继续退避轮询，`Generate=false` | 重启后按原 intent 继续轮询 |
| `GENERATING` / `SUBMISSION_UNCERTAIN` | 完成标志或超时对账结束 | 仍为 0 个或多组候选 | `RESULT_AMBIGUOUS` | 暂停并保存候选证据，零下载，`Generate=false` | 等待人工裁决，不重新生成 |
| 任意提交前状态 | `cancel` 与 `submit` 竞态 | cancel 取得同一执行锁且尚无 intent | `CANCELLED_PRE_SUBMIT` | 原子取消，`Generate=false` | 保持终态 |
| `SUBMITTING` / 已提交状态 | `cancel` | intent 已存在或 Provider 可能继续 | `LOCAL_WAIT_CANCELLED_PROVIDER_CONTINUES` | 停止本地等待/下载，`Generate=false` | 不允许 resume 到提交路径 |
| 任意自动化状态 | 页面动作 | fencing token 已过期或 owner 不匹配 | `PAUSED_FOR_HUMAN` | 拒绝所有页面写动作，`Generate=false` | 获取新 token 并重验；有 intent 时仍只能走恢复路径 |

每次状态变化写入 `job_events` 表，包含时间、原因、可重试性和诊断引用。后续实现仍须在上述硬守卫基础上补齐全部 source/event/guard/target/side-effect/restart 迁移；取消与提交争用同一执行锁，旧 fencing token 不得继续点击。

### FR-014 生成结果识别

结果匹配必须使用相互独立且能排除歧义的组合证据：

- 提交前后资产差异。
- 提交时间窗口。
- Prompt 或描述文本。
- 输出数量。
- 项目和模式。
- 页面卡片状态。

禁止单凭“页面最后一个卡片”或机械计数判定结果。M0 只在获授权的 executor 可明确验证新建空白项目时使用该项目；候选必须是提交前集合之外、当前项目内、提交后出现、状态由生成中变完成且数量与请求一致的唯一集合。页面仍显示生成中且未超时时，0 候选继续轮询；只有页面已显示完成或超时对账结束后仍为 0 个或多组候选，才进入 `RESULT_AMBIGUOUS`，不得自动下载。

### FR-015 下载与文件校验

流程：

1. 打开目标资产菜单。
2. 仅选择用户已请求且计入同一 job 累计成本后仍不超过 50 Credits 的格式；不得因页面提供更高格式而暗自升级。
3. 在点击前注册 Playwright `download` 事件。
4. 先保存到临时 `.part` 文件。
5. 下载完成后原子移动。
6. 计算 SHA-256。
7. 使用可靠媒体探测器验证魔数/容器、可解码视频流、宽高/比例/时长与请求及运行时结果一致，并用 `ffmpeg -xerror` 完整解码；真实下载缺少可靠探测或完整解码能力时不得进入 `COMPLETED`。
8. 写入 sidecar JSON。

文件名：

```text
YYYYMMDD-HHmmss_<project>_<model>_<ratio>_<duration>s_<jobid8>.mp4
```

示例：

```text
20260905-102355_product-ad_omni-flash-1.1_9x16_8s_a31d9f20.mp4
```

Sidecar：

```json
{
  "job_id": "job_a31d9f20",
  "provider": "flow_ui",
  "project_name": "product-ad",
  "project_url": "https://...",
  "model_requested": "omni-flash-1.1",
  "model_actual": "omni-flash-1.1",
  "duration_seconds": 8,
  "aspect_ratio": "9:16",
  "resolution": "720p",
  "credits_before": 812,
  "credits_after": 800,
  "balance_delta": -12,
  "credits_used": null,
  "credits_attribution_confidence": "unknown",
  "prompt_sha256": "...",
  "input_assets": [{"ordinal": 0, "content_sha256": "..."}],
  "asset_sha256": "...",
  "target_match_evidence": {"project_url": "https://...", "pre_submit_set_hash": "...", "provider_card_ref": "..."},
  "media_probe": {"container": "mp4", "width": 720, "height": 1280, "duration_seconds": 8.0},
  "full_decode": {"ok": true, "validator": "ffmpeg", "validator_version": "..."},
  "billing_source": "flow_ai_credits",
  "created_at": "2026-09-05T02:23:55Z"
}
```

Flow/AI Credits 可在同一账号跨设备共享，余额差额还可能受并发消费、返还或刷新影响；没有任务级可靠证据时，`credits_used` 必须为 `null`，不能把余额差额伪造成精确归因。默认不把完整 Prompt 写入公共文件。用户可以通过配置启用。

### FR-016 任务查询与取消

```bash
flowctl status <job_id> --json
flowctl list --state running --json
flowctl cancel <job_id> --json
```

取消规则：

- 尚未点击 Generate 时可以安全取消。
- 已提交后，取消只停止本地等待与下载，无法保证退还 Flow Credits。
- 返回字段明确说明 `provider_job_may_continue`。

### FR-017 失败诊断与人工接管

命令：

```bash
flowctl diagnose <job_id>
flowctl browser show
flowctl resume <job_id>
```

诊断包包含：

- 状态与事件日志。
- 脱敏后的请求。
- 页面截图。
- Playwright Trace。
- UI Fingerprint。
- 选择器失败位置。
- 浏览器和应用版本。

诊断包默认仅保存在本地，保留 7 天。M0 默认最小采集：登录/账号页禁止全屏截图；截图只截必要控件区域；Trace 关闭或过滤不必要的网络 body、source、Cookie、Authorization、Bearer Token、完整邮箱、Prompt 与素材路径。诊断目录/文件仅当前用户可读，启动时与每日运行 TTL 清理并记录删除审计。用户可以手动导出。

### FR-018 本地 REST API

基础端点：

```text

