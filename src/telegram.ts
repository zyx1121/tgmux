// Minimal Telegram Bot API client: plain fetch, no dependencies.

export type Message = {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: { id: number; username?: string };
  chat: { id: number; type: string; title?: string; is_forum?: boolean };
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_size?: number }[];
  document?: FileRef & { file_name?: string };
  video?: FileRef;
  audio?: FileRef & { file_name?: string };
  voice?: FileRef & { duration?: number };
  forum_topic_closed?: object;
  forum_topic_created?: { name: string };
  reply_markup?: { inline_keyboard?: { text: string; callback_data?: string }[][] };
};

type FileRef = { file_id: string; file_size?: number; mime_type?: string };

export type CallbackQuery = { id: string; from: { id: number }; data?: string; message?: Message };

export type Update = {
  update_id: number;
  message?: Message;
  callback_query?: CallbackQuery;
  stopped_message_generation?: { chat: { id: number }; message_thread_id?: number; draft_id: number };
};

export const MAX_TEXT = 4000;

export class Telegram {
  constructor(private token: string) {}

  async call<T = any>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
  }

  send(chat: number, thread: number | undefined, text: string, extra: Record<string, unknown> = {}) {
    return this.call<Message>("sendMessage", {
      chat_id: chat,
      message_thread_id: thread,
      text,
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  async sendLong(chat: number, thread: number | undefined, text: string, replyTo?: number) {
    for (const part of chunk(text || "(empty)")) await this.send(chat, thread, part, quote(replyTo));
  }

  edit(chat: number, message: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call("editMessageText", { chat_id: chat, message_id: message, text, ...extra }).catch((e) => {
      // Editing to identical text is a harmless no-op; anything else is worth a log line.
      if (!String(e).includes("not modified")) console.error(e);
    });
  }

  /** Download a file the user sent (Bot API limit: 20 MB) to `dest`. */
  async download(fileId: string, dest: string) {
    const file = await this.call<{ file_path: string }>("getFile", { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    await Bun.write(dest, res);
    return file.file_path;
  }

  /** Send a file from disk: images as photos (shown inline), everything else as a document. */
  async sendFile(chat: number, thread: number | undefined, path: string) {
    const file = Bun.file(path);
    const name = path.split("/").pop()!;
    const photo = /\.(png|jpe?g|webp)$/i.test(name) && file.size < 10_000_000;
    const form = new FormData();
    form.set("chat_id", String(chat));
    if (thread) form.set("message_thread_id", String(thread));
    form.set(photo ? "photo" : "document", file, name);
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${photo ? "sendPhoto" : "sendDocument"}`, {
      method: "POST",
      body: form,
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(`send ${name}: ${data.description}`);
  }

  async sendDocument(chat: number, thread: number | undefined, name: string, content: string) {
    const form = new FormData();
    form.set("chat_id", String(chat));
    if (thread) form.set("message_thread_id", String(thread));
    form.set("document", new Blob([content], { type: "text/plain" }), name);
    await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, { method: "POST", body: form });
  }
}

/** Split text into Telegram-sized parts, preferring newline boundaries. */
export function chunk(text: string, size = MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Reply to the message that asked, so the answer quotes it instead of the topic's opening line. */
export function quote(messageId?: number) {
  return messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {};
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "/claude@my_bot fix it" -> { cmd: "claude", args: "fix it" }; null for non-commands. */
export function parseCommand(text: string): { cmd: string; args: string } | null {
  const m = text.match(/^\/([A-Za-z0-9_-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return m ? { cmd: m[1], args: (m[2] ?? "").trim() } : null;
}

/** Drop the "@bot" suffix Telegram appends to commands picked from the menu in groups. */
export function stripBotSuffix(text: string) {
  return text.replace(/^(\/[A-Za-z0-9_:-]+)@\w+/, "$1");
}
