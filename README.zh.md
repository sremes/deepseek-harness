# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## Valjas 分支

Valjas（芬兰语，意为"harness"）是 DeepSeek Harness 的一个分支，用于试验自我改进的配置：让 agent 从自己的会话中学习可复用的技能。上文内容依然适用；本节只介绍该分支新增的内容。

### 分支新增了什么

- **从会话中学习（`dsh-session-meta`）。** 为每个会话在 `$DSH_HOME/meta/meta.db` 中记录一行摘要，并把会话分成三类：`track_a`（值得学习：成功挽回的错误或人类的纠正）、`track_b`（值得复现的崩溃或 bug）、`no_op`（无学习价值）。记录功能随基础 bundle 默认开启。完整说明见 [session-meta README](packages/session/session-meta/README.md)。
- **试运行技能草稿（`dsh-session-meta-replay`）。** 在技能上线前，用原任务把它跑一遍（分别测试有技能和无技能两种情况）。runner 由宿主装配；没有 runner 时草稿跳过试运行直接上线。完整说明见 [session-meta-replay README](packages/session/session-meta-replay/README.md)。
- **无人值守的审批（`dsh-approval-gate`）。** 在没有人类盯着时（headless 运行、CI）回答终端权限请求：拦截一小批危险命令，放行无聊的只读命令（`ls`、`cat`、`git status`），其余交给一个小型 AI 裁判；拿不准的一律转给人类。默认不挂载。完整说明见 [approval-gate README](packages/interaction/approval-gate/README.md)。

入库前会清除密钥：数据库里没有密钥，命令只记录形状（比如 `git`、3 个参数），从不存原文。

### 开启学习

记录功能开箱即用。教学功能需要手动开启：负责提议技能的 evaluator 在你指定模型路线之前一直处于关闭状态：

```yaml
- name: '@deepseek-ai/dsh-session-meta'
  config:
    dshHome: !!js process.env.DSH_HOME
    evaluator:
      enabled: true
      provider: <your-llm-route>
      model: <your-model>
```

默认值刻意收得很紧：每天一次 evaluator 调用，每周最多新增三个技能，每天最多八次重放。全部参数见 [session-meta README](packages/session/session-meta/README.md#use-this-package)。

日常使用只需要文件和一条查询：

- 把纠正意见写成 JSON，丢进 `$DSH_HOME/meta/steering/`，就能事后教学（"今后一律……"）。
- 把 `{ "reason": "..." }` 写成 `<技能主题>.json`，丢进 `$DSH_HOME/meta/invalidate/`，即可退役过时的技能。
- 用 `SELECT route, COUNT(*) FROM meta_sessions GROUP BY route;` 查询 `$DSH_HOME/meta/meta.db`，查看进展。

只有后台主机（例如 nightly cron）才设 `driveOnBoot: true`；交互式会话保持 `false`。

### 无人审批

```yaml
- name: '@deepseek-ai/dsh-user-approval'
- name: '@deepseek-ai/dsh-approval-gate'
  config:
    dshHome: !!js process.env.DSH_HOME
```

默认裁判需要在环境变量中提供 `TYPESAFE_KEY`。完整参数表和调参规则见 [approval-gate README](packages/interaction/approval-gate/README.md#use-this-package)。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
