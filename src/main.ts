// tgmux: a Telegram forum group as a terminal multiplexer.
// General topic = a persistent bash. `/claude` = a new topic running interactive Claude Code in tmux.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Shell } from "./shell";
import { Telegram, escapeHtml, parseCommand, stripBotSuffix, type Message, type Update } from "./telegram";
import * as tmux from "./tmux";

const env = (k: string, d?: string) => process.env[k] ?? d ?? "";
const TOKEN = env("TELEGRAM_BOT_TOKEN");
const CHAT = Number(env("TGMUX_CHAT", "0"));
const OWNERS = env("TGMUX_OWNERS").split(",").filter(Boolean).map(Number);
const WORKDIR = env("TGMUX_WORKDIR", join(homedir(), "work"));
const STATE_DIR = env("TGMUX_STATE", join(homedir(), ".local/state/tgmux"));
const PORT = Number(env("TGMUX_PORT", "8765"));
const CLAUDE = env("TGMUX_CLAUDE", join(homedir(), ".local/bin/claude"));
const HOOK_KEY = crypto.randomUUID();

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
mkdirSync(WORKDIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// ---------- state: which topic runs which Claude session ----------

type Topic = { sessionId?: string; named?: boolean; firstPrompt?: string };
const STATE_FILE = join(STATE_DIR, "state.json");
const state: { topics: Record<string, Topic> } = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { topics: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const tg = new Telegram(TOKEN);
const shell = new Shell(WORKDIR);

// ---------- Claude Code setup: hooks report back to this process ----------

const SETTINGS_FILE = join(STATE_DIR, "claude-settings.json");

function hookCommand(event: string) {
  return `curl -s -m 5 -X POST "http://127.0.0.1:${PORT}/hook/${event}?thread=$TGMUX_THREAD&key=$TGMUX_HOOK_KEY" -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1; true`;
}

function writeClaudeSettings() {
  const hook = (event: string) => [{ hooks: [{ type: "command", command: hookCommand(event) }] }];
  writeFileSync(
    SETTINGS_FILE,
    JSON.stringify(
      {
        model: env("TGMUX_MODEL", "opus"),
        skipDangerousModePermissionPrompt: true,
        hooks: { SessionStart: hook("start"), PreToolUse: hook("tool"), Stop: hook("stop") },
      },
      null,
      2,
    ),
  );
  // Skip first-run onboarding and the folder trust prompt for the work directory.
  const cfgPath = join(homedir(), ".claude.json");
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  cfg.hasCompletedOnboarding = true;
  cfg.theme ??= "dark";
  cfg.projects ??= {};
  cfg.projects[WORKDIR] = { ...cfg.projects[WORKDIR], hasTrustDialogAccepted: true };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

// ---------- per-topic runtime (not persisted) ----------

type Live = { status?: number; started?: () => void; screenTimer?: Timer };
const live = new Map<number, Live>();
const liveOf = (t: number) => live.get(t) ?? (live.set(t, {}), live.get(t)!);

async function startClaude(thread: number, resume?: string) {
  const started = new Promise<void>((r) => (liveOf(thread).started = r));
  const cmd = [CLAUDE, "--settings", SETTINGS_FILE, "--permission-mode", "bypassPermissions"];
  if (resume) cmd.push("--resume", resume);
  tmux.openWindow(thread, WORKDIR, cmd, {
    TGMUX_THREAD: String(thread),
    TGMUX_HOOK_KEY: HOOK_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: env("CLAUDE_CODE_OAUTH_TOKEN"),
  });
  // Wait for the SessionStart hook, then give the prompt box a moment to render.
  await Promise.race([started, Bun.sleep(20_000)]);
  await Bun.sleep(1500);
}

async function randomIcon(): Promise<string | undefined> {
  const stickers = await tg.call<{ custom_emoji_id?: string }[]>("getForumTopicIconStickers").catch(() => []);
  const ids = stickers.map((s) => s.custom_emoji_id).filter(Boolean) as string[];
  return ids[Math.floor(Math.random() * ids.length)];
}

async function newClaudeTopic(prompt: string) {
  const topic = await tg.call<{ message_thread_id: number }>("createForumTopic", {
    chat_id: CHAT,
    name: "claude",
    icon_custom_emoji_id: await randomIcon(),
  });
  const thread = topic.message_thread_id;
  state.topics[thread] = { firstPrompt: prompt || undefined };
  save();
  await startClaude(thread);
  if (prompt) await toClaude(thread, prompt);
  else await tg.send(CHAT, thread, "Claude is ready.");
}

async function toClaude(thread: number, text: string) {
  const topic = (state.topics[thread] ??= {});
  if (!tmux.hasWindow(thread)) {
    await tg.send(CHAT, thread, topic.sessionId ? "Resuming the session…" : "Starting Claude…");
    await startClaude(thread, topic.sessionId);
  }
  if (!topic.firstPrompt && !text.startsWith("/")) {
    topic.firstPrompt = text;
    save();
  }
  await tmux.sendText(thread, text);
  // Slash commands such as /cost or /model answer on screen without ending a turn: show the screen.
  if (text.startsWith("/")) scheduleScreen(thread, 2500);
}

function scheduleScreen(thread: number, ms: number) {
  const l = liveOf(thread);
  clearTimeout(l.screenTimer);
  l.screenTimer = setTimeout(() => sendScreen(thread), ms);
}

async function sendScreen(thread: number) {
  const screen = tmux.capture(thread).split("\n").slice(-60).join("\n");
  await tg.send(CHAT, thread, `<pre>${escapeHtml(screen.slice(-3800) || "(blank)")}</pre>`, { parse_mode: "HTML" });
}

async function nameTopic(thread: number, reply: string) {
  const topic = state.topics[thread];
  if (!topic || topic.named || !topic.firstPrompt) return;
  topic.named = true;
  save();
  const ask =
    "Write a 2 to 5 word title for this conversation, in the language the user wrote in. " +
    "Reply with the title only, no quotes or punctuation at the end.\n\n" +
    `User: ${topic.firstPrompt.slice(0, 1500)}\n\nAssistant: ${reply.slice(0, 1500)}`;
  const p = Bun.spawn([CLAUDE, "-p", "--model", "haiku", ask], { stdout: "pipe", stderr: "ignore", cwd: STATE_DIR });
  const title = (await new Response(p.stdout).text()).trim().split("\n")[0].slice(0, 128);
  if (title) await tg.call("editForumTopic", { chat_id: CHAT, message_thread_id: thread, name: title }).catch(console.error);
}

// ---------- hooks from Claude Code ----------

function describeTool(name: string, input: Record<string, any> = {}) {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? "";
  return `🔧 ${name}${detail ? ` ${String(detail).split("\n")[0].slice(0, 120)}` : ""}`;
}

async function onHook(event: string, thread: number, body: any) {
  const l = liveOf(thread);
  const topic = (state.topics[thread] ??= {});
  if (body.session_id && topic.sessionId !== body.session_id) {
    topic.sessionId = body.session_id;
    save();
  }
  if (event === "start") l.started?.();
  if (event === "tool") {
    clearTimeout(l.screenTimer);
    const text = describeTool(body.tool_name, body.tool_input);
    if (l.status) await tg.edit(CHAT, l.status, text);
    else l.status = (await tg.send(CHAT, thread, text, { disable_notification: true })).message_id;
  }
  if (event === "stop") {
    clearTimeout(l.screenTimer);
    if (l.status) await tg.call("deleteMessage", { chat_id: CHAT, message_id: l.status }).catch(() => {});
    l.status = undefined;
    const reply = String(body.last_assistant_message ?? "").trim();
    if (reply) {
      await tg.sendLong(CHAT, thread, reply);
      nameTopic(thread, reply).catch(console.error);
    }
  }
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/hook\/(\w+)$/);
    if (!m || url.searchParams.get("key") !== HOOK_KEY) return new Response("no", { status: 404 });
    const thread = Number(url.searchParams.get("thread"));
    const body = await req.json().catch(() => ({}));
    onHook(m[1], thread, body).catch(console.error);
    return new Response("ok");
  },
});

// ---------- General topic: the shell ----------

async function runShell(command: string) {
  const msg = await tg.send(CHAT, undefined, `$ ${command}\n…`);
  let out = "";
  let dirty = false;
  const render = (footer: string) => {
    const tail = out.length > 3500 ? `…\n${out.slice(-3500)}` : out;
    return `<pre><code class="language-shell">${escapeHtml(`$ ${command}\n${tail}`.trimEnd())}</code></pre>${footer}`;
  };
  const timer = setInterval(() => {
    if (dirty) tg.edit(CHAT, msg.message_id, render("\n…"), { parse_mode: "HTML" });
    dirty = false;
  }, 1500);
  const code = await shell.run(command, (s) => {
    out += s;
    dirty = true;
  });
  clearInterval(timer);
  out = out.replace(/\n$/, "");
  await tg.edit(CHAT, msg.message_id, render(code === 0 ? "" : `\nexit ${code}`), { parse_mode: "HTML" });
  if (out.length > 3500) await tg.sendDocument(CHAT, undefined, "output.txt", out);
}

const HELP = [
  "General topic",
  "  any text: runs in bash (pipes, &&, & all work; cd persists)",
  "  /claude [prompt]: open a new Claude topic",
  "  /stop: interrupt the running command",
  "",
  "Claude topic",
  "  any text or /command: goes to Claude Code",
  "  /screen: show the terminal",
  "  /keys Down Enter: press keys (tmux key names)",
  "  /kill: end the session and close the topic",
].join("\n");

// ---------- routing ----------

async function onMessage(msg: Message) {
  if (msg.chat.id !== CHAT || !OWNERS.includes(msg.from?.id ?? 0)) {
    console.log(`ignored chat=${msg.chat.id} (${msg.chat.title ?? msg.chat.type}) from=${msg.from?.id}`);
    return;
  }
  const thread = msg.is_topic_message ? msg.message_thread_id : undefined;
  if (msg.forum_topic_closed && thread) {
    tmux.closeWindow(thread);
    return;
  }
  if (!msg.text) return;
  const text = stripBotSuffix(msg.text);
  const cmd = parseCommand(text);

  if (thread === undefined) {
    if (cmd?.cmd === "claude") return newClaudeTopic(cmd.args);
    if (cmd?.cmd === "stop") return shell.interrupt();
    if (cmd?.cmd === "help" || cmd?.cmd === "start") return tg.send(CHAT, undefined, HELP);
    return runShell(text);
  }

  if (cmd?.cmd === "screen") return sendScreen(thread);
  if (cmd?.cmd === "keys") {
    tmux.sendKeys(thread, cmd.args.split(/\s+/).filter(Boolean));
    return scheduleScreen(thread, 800);
  }
  if (cmd?.cmd === "kill") {
    tmux.closeWindow(thread);
    delete state.topics[thread];
    save();
    return tg.call("closeForumTopic", { chat_id: CHAT, message_thread_id: thread });
  }
  return toClaude(thread, text);
}

async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.call<Update[]>("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) onMessage(u.message).catch(async (e) => {
          console.error(e);
          const thread = u.message!.is_topic_message ? u.message!.message_thread_id : undefined;
          await tg.send(u.message!.chat.id, thread, `tgmux error: ${e.message ?? e}`).catch(() => {});
        });
      }
    } catch (e) {
      console.error(e);
      await Bun.sleep(3000);
    }
  }
}

writeClaudeSettings();
await tg.call("setMyCommands", {
  commands: [
    { command: "claude", description: "Open a new Claude topic" },
    { command: "screen", description: "Show the Claude terminal" },
    { command: "stop", description: "Interrupt the shell" },
    { command: "help", description: "Usage" },
  ],
}).catch(console.error);
console.log(`tgmux up: chat=${CHAT} owners=${OWNERS.join(",")} workdir=${WORKDIR}`);
poll();
