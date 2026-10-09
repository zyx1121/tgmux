# tgmux

Your tmux, in a Telegram chat. The main chat is a shell; every `/claude` is a new topic running Claude Code.

[![CI](https://github.com/zyx1121/tgmux/actions/workflows/ci.yml/badge.svg)](https://github.com/zyx1121/tgmux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A terminal on your phone is miserable; a chat app is not. tgmux turns your private chat with a bot into a multiplexer for one Linux box: the main chat is a long-lived bash, and each Claude Code session gets its own topic, backed by a real tmux window you can also attach to over SSH. Output streams in as an animated draft with a stop button.

- **Run** any shell line from the main chat: pipes, `&&`, `&`, and `cd` that sticks between messages.
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

1. In @BotFather, open your bot's settings and turn on topic mode (threaded mode) for private chats.
2. Message the bot. `journalctl -u tgmux` prints `ignored chat=<id> from=<id>`.
3. Put that id in `TGMUX_OWNER`, then `sudo systemctl restart tgmux`.

## Commands

| Where | Message | Effect |
|-------|---------|--------|
| Main chat | any text | Runs in bash; output streams as a draft, long output also arrives as a file |
| Main chat | `/claude [prompt]` | New topic with Claude Code, optionally starting with a prompt |
| Main chat | `/stop` or the draft's stop button | Interrupts the running command |
| Main chat | `/get <path>` | Sends a file from the machine; files you send are saved to `~/work/inbox` |
| Topic | any text or `/command` | Typed into Claude Code; text and tool steps stream as a draft, the stop button sends Esc |
| Topic | photo or file | Saved to `~/work/inbox` and handed to Claude with your caption; files Claude puts in `$TGMUX_OUTBOX` come back when the turn ends |
| Topic | `/screen` | Sends the current terminal screen |
| Topic | `/keys Down Enter` | Presses keys (tmux key names), for pickers and menus |
| Topic | `/kill` | Ends the session and closes the topic |

Closing a topic in Telegram also ends its session. Idle sessions are closed to save memory, and a topic whose tmux window is gone resumes its Claude session on the next message.

## How it works

```
Telegram ── long poll ──> tgmux (Bun) ──> bash            (main chat)
                             │      └───> tmux window tN  (one per topic) ── claude
                             └── 127.0.0.1 HTTP <── Claude Code hooks (SessionStart, PreToolUse, Stop)
```

Claude Code runs with a generated `--settings` file whose hooks post back to tgmux: `PreToolUse` updates the streamed draft with the turn's text so far and the current tool, `Stop` delivers the final reply, and the session id is kept so a topic can resume after a reboot. `tmux attach -t tgmux` on the host shows every session.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | required | From @BotFather |
| `CLAUDE_CODE_OAUTH_TOKEN` | required | From `claude setup-token` |
| `TGMUX_OWNER` | required | Your Telegram user id; nobody else is answered |
| `TGMUX_WORKDIR` | `~/work` | Shell and Claude working directory |
| `TGMUX_MODEL` | `opus` | Claude Code model |
| `TGMUX_PORT` | `8765` | Local port for hooks |
| `TGMUX_IDLE_HOURS` | `2` | Close a Claude session idle this long (or sooner under memory pressure); the next message resumes it |

## Security

tgmux is a remote shell. Only your own private chat with the bot (`TGMUX_OWNER`) is executed, and Claude Code runs with `bypassPermissions`. Give it a dedicated machine, never a shared one.

## Contributing

Issues and PRs welcome, see [CONTRIBUTING](https://github.com/zyx1121/.github/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE). Built for typing `git log` from a train seat.
