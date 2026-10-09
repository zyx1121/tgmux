// Claude Code's slash commands in Telegram's command menu.
// Telegram only allows [a-z0-9_]{1,32}, so `/code-review` is listed as `/code_review` and mapped back.

/** Interactive-only commands that `claude -p` does not report. */
const INTERACTIVE = [
  "resume", "cost", "status", "memory", "permissions", "hooks", "plugin", "skills", "rewind",
  "export", "add-dir", "tasks", "btw", "statusline", "sandbox", "release-notes", "login", "logout", "exit",
];

export type Menu = { command: string; description: string }[];

export const telegramName = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);

/** The slash commands of this Claude Code install, read from the init event of a `-p` run, which is then killed. */
export async function claudeCommands(claude: string, cwd: string): Promise<string[]> {
  const p = Bun.spawn([claude, "-p", "--output-format", "stream-json", "--verbose", "x"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => p.kill(), 30_000);
  let found: string[] = [];
  let buf = "";
  const decoder = new TextDecoder();
  for await (const bytes of p.stdout) {
    buf += decoder.decode(bytes, { stream: true });
    const line = buf.split("\n").find((l) => l.includes('"subtype":"init"'));
    if (line) {
      found = JSON.parse(line).slash_commands ?? [];
      break;
    }
  }
  clearTimeout(timer);
  p.kill();
  return [...new Set([...found, ...INTERACTIVE])].filter((c) => !c.startsWith("_"));
}

/** tgmux's own commands first, then Claude's, within Telegram's 100-command limit. */
export function buildMenu(own: Menu, claude: string[]) {
  const aliases = new Map<string, string>();
  const menu: Menu = [...own];
  const taken = new Set(own.map((c) => c.command));
  for (const name of claude) {
    const tg = telegramName(name);
    if (taken.has(tg) || menu.length >= 100) continue;
    taken.add(tg);
    if (tg !== name) aliases.set(tg, name);
    menu.push({ command: tg, description: `Claude Code /${name}` });
  }
  return { menu, aliases };
}

/** "/code_review high" -> "/code-review high" for commands the menu renamed. */
export function unalias(text: string, aliases: Map<string, string>) {
  const m = text.match(/^\/([a-z0-9_]+)(?=\s|$)/);
  const real = m && aliases.get(m[1]);
  return real ? `/${real}${text.slice(m[0].length)}` : text;
}
