---
description: "经脱敏的单会话聚合、确定性分诊与 SQLite 元存储：为组合或调试 dsh-meta 的算子与维护者提供的学习循环输入侧。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-meta

[English](README.md) | 中文

## 摘要

`dsh-session-meta` 是 dsh-meta 学习循环中只观察的输入侧（Plan-V1 M1）。
它接入会话事件流（`session/event`、`session/flush`、`session/disposed`、
`agent/error`——与遥测协调器相同的采集模式），脱敏后按会话折叠聚合，
经确定性分诊（`track_a` / `track_b` / `no_op`），持久化为一行一会话外加
有界证据，存入 `$DSH_HOME/meta/meta.db`。它不写 skills，不改循环状态；
晋升逻辑在 M3。

## 目录

- [使用本包](#使用本包)
- [理解实现](#理解实现)
- [进一步探索](#进一步探索)
- [模型体验](#模型体验)
- [已知限制与延期工作](#已知限制与延期工作)
- [开发说明](#开发说明)

-----

<a id="使用本包"></a>
## 使用本包

在任何需要将会话喂给学习循环的 profile 中，将本插件装在会话存储旁。
它不依赖其他插件——直接读事件总线，因此可与任意遥测后端共存，或在
没有后端时独立工作。

### 组合

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-meta'
  config:
    dshHome: !!js process.env.DSH_HOME
```

若只想做一次冒烟运行而不碰真实 home，可显式传 `dbPath`（测试用
`:memory:`）：

```yaml
- name: '@deepseek-ai/dsh-session-meta'
  config:
    dshHome: '/tmp/meta-smoke'
    dbPath: ':memory:'
```

### 配置

| 字段 | 含义 |
|---|---|
| `dshHome` | 哈尼斯 home。Schema 必填；启动器经补丁传入 `process.env.DSH_HOME`。 |
| `dbPath` | 数据库绝对路径。为空（默认）时解析为 `$DSH_HOME/meta/meta.db`。 |
| `maxEvidencePerSession` | 每个会话保留的证据行数（仅错误与转向）。默认 200；超限计入 `dropped_evidence`。 |

### 行含义

`meta_sessions` 为每个终结会话存一行：身份（`id`、`cwd`、
`parent_session`、`origin`）、计数（`events`、`tool_calls`、
`steering_events`、`feedback_events`、`assistant_messages`）、JSON 编码的
`tool_errors` / `agent_errors` 名称列表、最后一次 `turn_end_reason`，以及
分诊结论（`route`、`reasons`）。`meta_evidence` 为每个会话存至多
`maxEvidencePerSession` 行脱敏诊断证据。

M1 的报告原语是 SQL：

```sql
SELECT route, COUNT(*) FROM meta_sessions GROUP BY route;
```

### 分诊路由

| 路由 | 触发条件 |
|---|---|
| `track_b` | 结构性错误（`SyntaxError`、`JSONParseError`、`ZodError`、`ERR_REGEX_TIMEOUT`、`ERR_TOOL_SCHEMA_VIOLATION`）、任意 `agent/error`、未恢复的工具错误，或未 `completed` 的 turn 结束。 |
| `track_a` | 人工转向（首条 assistant 消息之后的 `user` 源 `user/message`），或已证实的恢复：`completed` 回合中每个失败步骤都有后续同工具成功步骤（`success-recovered`，无论有无转向）。 |
| `no_op` | 无上述信号。 |

结果 call id 从顶层 `callId`、`message.callId`、`message.source.callId` 或内容块 `toolCallId`（线上 `dsh-tool-result` 形态）读取；无步骤证据的错误名仍计数，但永不证明恢复。

消息源非人工的收件箱事件（`agent-message` 中转、工具帧、插件通告）
永不视为转向。

### Track A 评估输入（M2.1）

评估器看到的是接地的投影，而非摘要：工具步骤携带脱敏截断后的调用参数
（`args`，500 字符）与失败步骤的结果摘要（300 字符）；当后续同工具步骤
成功时，失败步骤标记恢复（`recovered` 及重试参数 `retryArgs`）；负载包含
咨询过的技能（`skillsConsulted`）、回合结果（`completed`）与已提议签名
（`known_signatures`，从技能根目录读取）。提案必须包含
`trigger_conditions`，渲染为草稿的 `whenToUse`。提示规则：重过程而非叙事，
pitfall = 规则 + 一句 WHY，不带事件标识符，不重复工具 Schema，
不断言工具损坏。

<a id="理解实现"></a>
## 理解实现

同步处理器只做聚合与缓冲。SQLite 写只发生在 `session/flush` 与
`session/disposed`，从不在事件热路径上。规范会话日志永不改写——脱敏仅
作用于元副本（PEM 块、已知令牌前缀、`key=value` 机密、`cwd` → `$CWD`、
home → `~`，以及字符串/数组/深度边限）。磁盘 Schema 带版本
（`PRAGMA user_version = 1`）；版本不符直接抛错，不做迁移。

<details>
<summary>开发者章节：模块划分</summary>

- `src/index.ts` —— 函数插件（`name`/`inject`/`Config`/`apply`，无默认导出）：事件流接入、flush/dispose 终结、store 生命周期。
- `src/triage.ts` —— 基于 `SessionAggregate` 的纯确定性路由；全分支无需 cordis 即可单测。
- `src/redact.ts` —— 机密擦除与边限。
- `src/store.ts` —— `node:sqlite` 元存储（`MetaStore`、`META_SCHEMA_VERSION`）。
- `src/types.ts` —— 仅类型。

</details>

<a id="进一步探索"></a>
## 进一步探索

- Plan-V1（SilverBullet `Projects/Self-Improving-Harness/Plan-V1`，在本仓库之外）——本仓库内的契约即本 README 加测试套件。
- 遥测采集模式：`../session-telemetry/src/coordinator.ts`。
- M3 将经由其写入的技能 frontmatter 门禁：`../../skill/skill-filesystem/src/index.ts`（`disable-model-invocation`、`metadata:`）。

<a id="模型体验"></a>
## 模型体验

### 请求上下文与条件

#### 模型能看到什么

经由 M3 循环将写出的 skills 间接可见。本包自身不贡献系统提示章节、
不贡献工具、不贡献单步上下文。

#### Token 影响

零直接 token 影响。

#### KV 缓存影响

独立行为。本插件从不修改请求上下文、工具 Schema 或系统提示章节，
因此不可能破坏前缀复用。Provider 侧缓存可用性与逐出不在本包契约内。

<a id="已知限制与延期工作"></a>
## 已知限制与延期工作

- **尚无查询服务** —— M1 的报告面是直查 `meta.db` 的 SQL；`ctx.meta` 查询 API 延期至 M2。
- **转向启发式较窄** —— 仅首条 assistant 消息之后的人工消息计数；headless 编排器纠正记录尚未接入（M2）。
- **反馈情感不解析** —— `feedback/record` 事件只计参与度；Like/Dislike 极性经 `message-feedback` 在 M2 接入。
- **无通用高熵机密检测** —— 无键锚或已知前缀的机密会通过；工具参数中的哈希与 id 系有意保留。
- **证据系有意有损** —— 只保留错误与转向，按会话封顶；全量回放仍在规范会话日志中。

<a id="开发说明"></a>
## 开发说明

覆盖率要求单文件 100%：`tests/redact.spec.ts` 与 `tests/triage.spec.ts`
钉住纯模块全分支，`tests/loader-composition.spec.ts` 经 vendored Loader
启动发布态 YAML 断言持久化行（路由、脱敏、证据封顶、直方图）并钉住无
默认导出。
