# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Valjas fork

Valjas (Finnish for "harness") is a fork of DeepSeek Harness that experiments with a self-improving setup: the agent learns reusable skills from its own sessions. Everything above still applies; this section covers only what the fork adds.

### What the fork adds

- **Learning from sessions (`dsh-session-meta`).** Records one summary row per session in `$DSH_HOME/meta/meta.db` and sorts sessions into `track_a` (worth learning from: a recovery or a human correction), `track_b` (a crash or bug worth reproducing), or `no_op`. Recording ships in the base bundle, so it is on by default. Contract: [session-meta README](packages/session/session-meta/README.md).
- **Testing skill drafts (`dsh-session-meta-replay`).** Replays a proposed skill against its original task, with and without the skill, before it goes live. The host wires the runner; without one, drafts promote without replay. Contract: [session-meta-replay README](packages/session/session-meta-replay/README.md).
- **Unattended approvals (`dsh-approval-gate`).** Answers terminal-permission prompts when no human is watching (headless runs, CI): it blocks a short list of dangerous commands, allows boring read-only ones (`ls`, `cat`, `git status`), and asks a small AI judge about the rest. Anything unclear falls through to a human. Not mounted by default. Contract: [approval-gate README](packages/interaction/approval-gate/README.md).

Secrets are scrubbed before anything is stored: the database never sees them, and commands are logged as shapes (`git`, 3 args), never raw text.

### Turning on learning

Recording needs no setup. Teaching does: the evaluator that proposes skills stays off until you point it at a model route:

```yaml
- name: '@deepseek-ai/dsh-session-meta'
  config:
    dshHome: !!js process.env.DSH_HOME
    evaluator:
      enabled: true
      provider: <your-llm-route>
      model: <your-model>
```

The defaults are tight on purpose: one evaluator call per day, at most three new skills per week, eight replay runs per day. Every knob is listed in the [session-meta README](packages/session/session-meta/README.md#use-this-package).

Day to day, the loop runs on files and one query:

- Teach after the fact by dropping a correction note as JSON into `$DSH_HOME/meta/steering/` ("from now on, always …").
- Retire a skill the world has outgrown by dropping `{ "reason": "..." }` into `$DSH_HOME/meta/invalidate/` under the file name `<skill-topic>.json`.
- Check progress with `SELECT route, COUNT(*) FROM meta_sessions GROUP BY route;` against `$DSH_HOME/meta/meta.db`.

Set `driveOnBoot: true` only on background hosts such as a nightly cron job; interactive sessions leave it at `false`.

### Approvals without a human

```yaml
- name: '@deepseek-ai/dsh-user-approval'
- name: '@deepseek-ai/dsh-approval-gate'
  config:
    dshHome: !!js process.env.DSH_HOME
```

The default judge needs `TYPESAFE_KEY` in the environment. The full option table and tuning rules live in the [approval-gate README](packages/interaction/approval-gate/README.md#use-this-package).

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
