// tgmux: your private chat with the bot, in topic mode, as a terminal multiplexer.
// The `shell` topic = a persistent bash. Every other topic = interactive Claude Code in a tmux window.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildMenu, claudeCommands, unalias } from "./commands";
import { Draft } from "./draft";
import { Shell } from "./shell";
import { Telegram, escapeHtml, quote, parseCommand, stripBotSuffix, type CallbackQuery, type Message, type Update } from "./telegram";
import * as tmux from "./tmux";

const env = (k: string, d?: string) => process.env[k] ?? d ?? "";
const TOKEN = env("TELEGRAM_BOT_TOKEN");
// The owner's Telegram user id; in a private chat it is also the chat id.
const CHAT = Number(env("TGMUX_OWNER", "0"));
const WORKDIR = env("TGMUX_WORKDIR", join(homedir(), "work"));
const STATE_DIR = env("TGMUX_STATE", join(homedir(), ".local/state/tgmux"));
const PORT = Number(env("TGMUX_PORT", "8765"));
const IDLE_HOURS = Number(env("TGMUX_IDLE_HOURS", "2"));
const CLAUDE = env("TGMUX_CLAUDE", join(homedir(), ".local/bin/claude"));
const HOOK_KEY = crypto.randomUUID();
const INBOX = join(WORKDIR, "inbox");
const outbox = (thread: number) => join(STATE_DIR, "outbox", `t${thread}`);
const OUTBOX_PROMPT =
  "You are being used through Telegram (tgmux). Files the user sends are saved under ./inbox and their paths " +
  "appear in the message. To send a file back to the user, copy it into the directory in the TGMUX_OUTBOX " +
  "environment variable; everything there is delivered when your turn ends.";

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
mkdirSync(WORKDIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// ---------- state: which topic runs which Claude session ----------

type Topic = { sessionId?: string; named?: boolean; firstPrompt?: string; lastActive?: number };
const STATE_FILE = join(STATE_DIR, "state.json");
const state: { topics: Record<string, Topic>; shellThread?: number } = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { topics: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const tg = new Telegram(TOKEN);
let aliases = new Map<string, string>();
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

type Live = { draft?: Draft; started?: () => void; screenTimer?: Timer; asked?: number };
const live = new Map<number, Live>();
const liveOf = (t: number) => live.get(t) ?? (live.set(t, {}), live.get(t)!);

async function startClaude(thread: number, resume?: string) {
  const started = new Promise<void>((r) => (liveOf(thread).started = r));
  mkdirSync(outbox(thread), { recursive: true });
  const cmd = [CLAUDE, "--settings", SETTINGS_FILE, "--permission-mode", "bypassPermissions", "--append-system-prompt", OUTBOX_PROMPT];
  if (resume) cmd.push("--resume", resume);
  tmux.openWindow(thread, WORKDIR, cmd, {
    TGMUX_THREAD: String(thread),
    TGMUX_HOOK_KEY: HOOK_KEY,
    TGMUX_OUTBOX: outbox(thread),
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

async function toClaude(thread: number, text: string, messageId?: number) {
  const topic = (state.topics[thread] ??= {});
  const l = liveOf(thread);
  react(messageId, "👀");
  l.asked = messageId;
  if (!tmux.hasWindow(thread)) {
    await tg.send(CHAT, thread, topic.sessionId ? "Resuming the session…" : "Starting Claude…");
    await startClaude(thread, topic.sessionId);
  }
  if (!topic.firstPrompt && !text.startsWith("/")) topic.firstPrompt = text;
  topic.lastActive = Date.now();
  save();
  await tmux.sendText(thread, text);
  // Slash commands such as /cost or /model answer on screen without ending a turn: show the screen.
  if (text.startsWith("/")) scheduleScreen(thread, 2500);
  else {
    turnDraft(thread).show("");
    stopTyping.get(thread)?.();
    stopTyping.set(thread, typing(thread));
  }
}

const stopTyping = new Map<number, () => void>();

/** The draft streaming the current Claude turn in a topic, created on first use. */
function turnDraft(thread: number) {
  const l = liveOf(thread);
  if (!l.draft?.active) l.draft = new Draft(tg, CHAT, thread);
  return l.draft;
}

/** Assistant text written so far in the current turn, read from the session transcript. */
function turnText(transcriptPath?: string) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  const lines = readFileSync(transcriptPath, "utf8").trimEnd().split("\n").slice(-300);
  let texts: string[] = [];
  for (const line of lines) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e.message?.content;
    // A real user prompt (string content) starts a new turn; tool results are arrays.
    if (e.type === "user" && typeof content === "string") texts = [];
    if (e.type === "assistant" && Array.isArray(content))
      for (const c of content) if (c.type === "text" && c.text.trim()) texts.push(c.text.trim());
  }
  return texts.join("\n\n");
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

// ---------- feedback: reactions on your message, "typing…" while work runs ----------

function react(message: number | undefined, emoji?: string) {
  if (!message) return;
  tg.call("setMessageReaction", {
    chat_id: CHAT,
    message_id: message,
    reaction: emoji ? [{ type: "emoji", emoji }] : [],
  }).catch((e) => console.error(String(e)));
}

/** Show "typing…" in the thread until the returned function is called (Telegram clears it after 5 s). */
function typing(thread: number | undefined) {
  const tick = () =>
    tg.call("sendChatAction", { chat_id: CHAT, message_thread_id: thread, action: "typing" }).catch(() => {});
  tick();
  const timer = setInterval(tick, 4000);
  return () => clearInterval(timer);
}

// ---------- idle sessions: free memory, resume on the next message ----------

function memAvailableMb() {
  const m = readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/);
  return m ? Number(m[1]) / 1024 : Infinity;
}

async function reapIdle() {
  const now = Date.now();
  const running = Object.entries(state.topics)
    .map(([t, topic]) => ({ thread: Number(t), idle: now - (topic.lastActive ?? 0) }))
    .filter(({ thread }) => tmux.hasWindow(thread) && !live.get(thread)?.draft?.active)
    .sort((a, b) => b.idle - a.idle);
  const victims = running.filter((r) => r.idle > IDLE_HOURS * 3_600_000);
  // Under memory pressure also take the longest-idle session that has been quiet for 10 minutes.
  const spare = running.find((r) => r.idle > 600_000 && !victims.includes(r));
  if (memAvailableMb() < 400 && spare) victims.push(spare);
  for (const { thread } of victims) {
    tmux.closeWindow(thread);
    console.log(`reaped idle session t${thread}`);
    await tg.send(CHAT, thread, "💤 Paused to free memory. Your next message resumes this session.", {
      disable_notification: true,
    }).catch(() => {});
  }
}

setInterval(() => reapIdle().catch(console.error), 600_000);
setTimeout(() => reapIdle().catch(console.error), 60_000);

// ---------- files: Telegram -> ./inbox, TGMUX_OUTBOX -> Telegram ----------

/** Save an attachment to the inbox; returns its path, or undefined for a message without one. */
async function saveAttachment(msg: Message) {
  const f = msg.document ?? msg.video ?? msg.audio ?? msg.photo?.at(-1);
  if (!f) return;
  const original = (msg.document?.file_name ?? msg.audio?.file_name) || undefined;
  mkdirSync(INBOX, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const tmp = join(INBOX, `${stamp}-${msg.message_id}`);
  const remote = await tg.download(f.file_id, tmp);
  const ext = remote.includes(".") ? `.${remote.split(".").pop()}` : "";
  const name = original ? `${stamp}-${original.replace(/[^\w.-]+/g, "_")}` : `${stamp}-${msg.message_id}${ext}`;
  const dest = join(INBOX, name);
  if (dest !== tmp) Bun.spawnSync(["mv", tmp, dest]);
  return dest;
}

async function deliverOutbox(thread: number) {
  const dir = outbox(thread);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    await tg.sendFile(CHAT, thread, path).then(
      () => rmSync(path),
      (e) => tg.send(CHAT, thread, `Could not send ${name}: ${e.message ?? e} (kept in ${dir})`),
    );
  }
}

// ---------- AskUserQuestion: Claude's picker as inline buttons ----------

type Question = { question: string; header?: string; options?: { label: string; description?: string }[] };

async function askButtons(thread: number, questions: Question[]) {
  for (const [qi, q] of questions.entries()) {
    const options = q.options ?? [];
    const lines = options.map((o, i) => `${i + 1}. ${o.label}${o.description ? `: ${o.description}` : ""}`);
    await tg.send(CHAT, thread, [q.question, "", ...lines].join("\n"), {
      reply_markup: {
        inline_keyboard: options.map((o, oi) => [{ text: o.label, callback_data: `q:${qi}:${oi}` }]),
      },
    });
  }
}

/** A picker button: move the highlight to that option and press Enter, as a person would. */
async function onAnswer(cb: CallbackQuery) {
  await tg.call("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
  const m = cb.data?.match(/^q:(\d+):(\d+)$/);
  const msg = cb.message;
  if (!m || !msg?.message_thread_id || cb.from.id !== CHAT) return;
  const thread = msg.message_thread_id;
  tmux.sendKeys(thread, [...Array(Number(m[2])).fill("Down"), "Enter"]);
  const chosen = msg.reply_markup?.inline_keyboard?.[Number(m[2])]?.[0]?.text ?? "";
  await tg.call("editMessageReplyMarkup", { chat_id: CHAT, message_id: msg.message_id }).catch(() => {});
  await tg.send(CHAT, thread, `✓ ${chosen}`, { disable_notification: true });
  turnDraft(thread).show("");
  stopTyping.get(thread)?.();
  stopTyping.set(thread, typing(thread));
}

// ---------- hooks from Claude Code ----------

function describeTool(name: string, input: Record<string, any> = {}) {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? "";
  return `🔧 ${name}${detail ? ` ${String(detail).split("\n")[0].slice(0, 120)}` : ""}`;
}

async function onHook(event: string, thread: number, body: any) {
  const l = liveOf(thread);
  const topic = (state.topics[thread] ??= {});
  topic.lastActive = Date.now();
  if (body.session_id && topic.sessionId !== body.session_id) {
    topic.sessionId = body.session_id;
    save();
  }
  if (event === "start") l.started?.();
  if (event === "tool" && body.tool_name === "AskUserQuestion") {
    clearTimeout(l.screenTimer);
    l.draft?.end();
    stopTyping.get(thread)?.();
    await askButtons(thread, body.tool_input?.questions ?? []);
    return;
  }
  if (event === "tool") {
    clearTimeout(l.screenTimer);
    if (!stopTyping.has(thread)) stopTyping.set(thread, typing(thread));
    const sofar = turnText(body.transcript_path);
    turnDraft(thread).show(`${sofar}${sofar ? "\n\n" : ""}${describeTool(body.tool_name, body.tool_input)}`);
  }
  if (event === "stop") {
    clearTimeout(l.screenTimer);
    l.draft?.end();
    stopTyping.get(thread)?.();
    stopTyping.delete(thread);
    const asked = l.asked;
    react(asked, "👌");
    l.asked = undefined;
    await deliverOutbox(thread);
    const reply = String(body.last_assistant_message ?? "").trim();
    if (reply) {
      await tg.sendMarkdown(CHAT, thread, reply, asked);
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

let shellDraft: Draft | undefined;

async function runShell(command: string, messageId?: number) {
  react(messageId, "👀");
  const stop = typing(state.shellThread);
  let out = "";
  const render = (footer: string) => {
    const tail = out.length > 3500 ? `…\n${out.slice(-3500)}` : out;
    return `<pre><code class="language-shell">${escapeHtml(`$ ${command}\n${tail}`.trimEnd())}</code></pre>${footer}`;
  };
  const draft = (shellDraft = new Draft(tg, CHAT, state.shellThread, { parse_mode: "HTML" }));
  draft.show(render(""));
  const code = await shell.run(command, (s) => {
    out += s;
    draft.show(render(""));
  });
  draft.end();
  stop();
  react(messageId, code === 0 ? "👌" : "👎");
  out = out.replace(/\n$/, "");
  await tg.send(CHAT, state.shellThread, render(code === 0 ? "" : `\nexit ${code}`), {
    parse_mode: "HTML",
    ...quote(messageId),
  });
  if (out.length > 3500) await tg.sendDocument(CHAT, state.shellThread, "output.txt", out);
}

/** The draft's stop button: interrupt the shell command or Claude's turn it belongs to. */
function onStopped(thread: number | undefined, draftId: number) {
  if (thread === undefined || thread === state.shellThread) {
    if (shellDraft?.id === draftId) shell.interrupt();
    return;
  }
  const l = liveOf(thread);
  if (l.draft?.id !== draftId) return;
  l.draft.end();
  tmux.sendKeys(thread, ["Escape"]);
}

const HELP = [
  "New thread: a new Claude Code session (type anything in the main chat)",
  "",
  "shell topic",
  "  any text: runs in bash (pipes, &&, & all work; cd persists)",
  "  /claude [prompt]: open a new Claude topic from here",
  "  /stop or the draft's stop button: interrupt the running command",
  "  /get <path>: send a file from the machine; sending a file saves it to ~/work/inbox",
  "",
  "Claude topic",
  "  any text or /command: goes to Claude Code (the stop button sends Esc)",
  "  photos and files: saved to ./inbox and handed to Claude; files Claude makes come back",
  "  /screen: show the terminal",
  "  /keys Down Enter: press keys (tmux key names)",
  "  /kill: end the session and close the topic",
].join("\n");

// ---------- routing ----------

async function onMessage(msg: Message) {
  if (msg.chat.type !== "private" || msg.chat.id !== CHAT || msg.from?.id !== CHAT) {
    console.log(`ignored chat=${msg.chat.id} (${msg.chat.title ?? msg.chat.type}) from=${msg.from?.id}`);
    return;
  }
  const thread = msg.is_topic_message ? msg.message_thread_id : undefined;
  if (msg.forum_topic_closed && thread) {
    tmux.closeWindow(thread);
    return;
  }
  const attachment = await saveAttachment(msg);
  if (attachment && (thread === undefined || thread === state.shellThread)) {
    react(msg.message_id, "👌");
    return tg.send(CHAT, thread, `Saved to ${attachment}`, quote(msg.message_id));
  }
  const body = msg.text ?? msg.caption ?? "";
  if (!body && !attachment) return;
  const text = attachment ? `${body}\n\n[attached file: ${attachment}]`.trim() : stripBotSuffix(body);
  const cmd = parseCommand(text);

  if (thread === undefined || thread === state.shellThread) {
    if (cmd?.cmd === "claude") return newClaudeTopic(cmd.args);
    if (cmd?.cmd === "stop") return shell.interrupt();
    if (cmd?.cmd === "get") return tg.sendFile(CHAT, thread, cmd.args.replace(/^~(?=\/)/, homedir()));
    if (cmd?.cmd === "help" || cmd?.cmd === "start") return tg.send(CHAT, state.shellThread, HELP);
    return runShell(text, msg.message_id);
  }

  if (cmd?.cmd === "help") return tg.send(CHAT, thread, HELP);
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
  return toClaude(thread, unalias(text, aliases), msg.message_id);
}

async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.call<Update[]>("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query", "stopped_message_generation"],
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        const stop = u.stopped_message_generation;
        if (stop?.chat.id === CHAT) onStopped(stop.message_thread_id, stop.draft_id);
        if (u.callback_query) onAnswer(u.callback_query).catch(console.error);
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
const OWN_COMMANDS = [
  { command: "claude", description: "tgmux: open a new Claude topic" },
  { command: "screen", description: "tgmux: show the Claude terminal" },
  { command: "keys", description: "tgmux: press keys, e.g. /keys Down Enter" },
  { command: "kill", description: "tgmux: end this Claude session" },
  { command: "stop", description: "tgmux: interrupt the shell" },
  { command: "get", description: "tgmux: send a file, e.g. /get ~/work/out.png" },
  { command: "help", description: "tgmux: usage" },
];
// The menu lists Claude Code's commands too; refreshed on every start, so new skills appear after a restart.
claudeCommands(CLAUDE, WORKDIR)
  .then((names) => {
    const built = buildMenu(OWN_COMMANDS, names);
    aliases = built.aliases;
    return tg.call("setMyCommands", { commands: built.menu });
  })
  .catch(console.error);
const me = await tg.call<{ username: string; has_topics_enabled?: boolean }>("getMe");
if (!me.has_topics_enabled) console.warn(`@${me.username}: turn on threaded mode in the @BotFather Mini App`);
if (me.has_topics_enabled && CHAT && !state.shellThread) {
  const t = await tg.call<{ message_thread_id: number }>("createForumTopic", { chat_id: CHAT, name: "shell" });
  state.shellThread = t.message_thread_id;
  save();
  await tg.send(CHAT, state.shellThread, HELP);
}
console.log(`tgmux up: @${me.username} owner=${CHAT} workdir=${WORKDIR}`);
poll();
