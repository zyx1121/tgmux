# tgmux

Your tmux, in a Telegram group. General is a shell; every `/claude` is a new topic running Claude Code.

[![CI](https://github.com/zyx1121/tgmux/actions/workflows/ci.yml/badge.svg)](https://github.com/zyx1121/tgmux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A terminal on your phone is miserable; a chat app is not. tgmux turns a Telegram forum group into a multiplexer for one Linux box: the General topic is a long-lived bash, and each Claude Code session gets its own topic, backed by a real tmux window you can also attach to over SSH.

- **Run** any shell line from General: pipes, `&&`, `&`, and `cd` that sticks between messages.
- **Open** a Claude Code session with `/claude [prompt]`: a new topic with a random icon, renamed after the first exchange.
- **Use** every Claude Code slash command inside a topic, because it is the interactive CLI, not `claude -p`.

## Quickstart

On a Debian host with `sudo`:

```bash
git clone https://github.com/zyx1121/tgmux && cd tgmux
./deploy/install.sh          # installs tmux, Bun and Claude Code, then asks you to fill the env file
$EDITOR ~/.config/tgmux/env  # TELEGRAM_BOT_TOKEN and CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`)
./deploy/install.sh          # starts the tgmux systemd service
```

Then in Telegram:

1. Create a group, turn on Topics, add your bot as an admin with "Manage topics".
2. Send any message in General. `journalctl -u tgmux` prints `ignored chat=<id> from=<id>`.
3. Put those ids in `TGMUX_CHAT` and `TGMUX_OWNERS`, then `sudo systemctl restart tgmux`.

## Commands

| Where | Message | Effect |
|-------|---------|--------|
| General | any text | Runs in bash; output streams into one message, long output also arrives as a file |
| General | `/claude [prompt]` | New topic with Claude Code, optionally starting with a prompt |
| General | `/stop` | Interrupts the running command |
| Topic | any text or `/command` | Typed into Claude Code; replies arrive when the turn ends |
| Topic | `/screen` | Sends the current terminal screen |
| Topic | `/keys Down Enter` | Presses keys (tmux key names), for pickers and menus |
| Topic | `/kill` | Ends the session and closes the topic |

Closing a topic in Telegram also ends its session. A topic whose tmux window is gone resumes its Claude session on the next message.

## How it works

```
Telegram ── long poll ──> tgmux (Bun) ──> bash            (General)
                             │      └───> tmux window tN  (one per topic) ── claude
                             └── 127.0.0.1 HTTP <── Claude Code hooks (SessionStart, PreToolUse, Stop)
```

Claude Code runs with a generated `--settings` file whose hooks post back to tgmux: `PreToolUse` drives a live tool status line, `Stop` delivers the final reply, and the session id is kept so a topic can resume after a reboot. `tmux attach -t tgmux` on the host shows every session.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | required | From @BotFather |
| `CLAUDE_CODE_OAUTH_TOKEN` | required | From `claude setup-token` |
| `TGMUX_CHAT` | required | Forum group chat id |
| `TGMUX_OWNERS` | required | Comma-separated Telegram user ids allowed to use it |
| `TGMUX_WORKDIR` | `~/work` | Shell and Claude working directory |
| `TGMUX_MODEL` | `opus` | Claude Code model |
| `TGMUX_PORT` | `8765` | Local port for hooks |

## Security

tgmux is a remote shell. Only messages from `TGMUX_OWNERS` in `TGMUX_CHAT` are executed, and Claude Code runs with `bypassPermissions`. Give it a dedicated machine, never a shared one.

## Contributing

Issues and PRs welcome, see [CONTRIBUTING](https://github.com/zyx1121/.github/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE). Built for typing `git log` from a train seat.
