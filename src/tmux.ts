// Phone-width panes: Claude Code renders for 60 columns, so screens read well in Telegram.
// Each Claude topic is one window in the `tgmux` tmux session, so `tmux attach -t tgmux` shows them all.

export const SESSION = "tgmux";

function tmux(...args: string[]) {
  const r = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}

export const windowName = (thread: number) => `t${thread}`;
const target = (thread: number) => `${SESSION}:${windowName(thread)}`;

export function hasWindow(thread: number) {
  return tmux("list-windows", "-t", SESSION, "-F", "#{window_name}").out.split("\n").includes(windowName(thread));
}

/** Start `command` in a new window for this thread; the tmux session is created on first use. */
export function openWindow(thread: number, cwd: string, command: string[], env: Record<string, string>) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const where = tmux("has-session", "-t", SESSION).ok
    ? ["new-window", "-d", "-t", SESSION]
    : ["new-session", "-d", "-s", SESSION, "-x", "60", "-y", "40"];
  const r = tmux(...where, "-n", windowName(thread), "-c", cwd, ...envArgs, "--", ...command);
  if (!r.ok) throw new Error(r.err.trim());
}

export function closeWindow(thread: number) {
  tmux("kill-window", "-t", target(thread));
}

/** Type text into the window as one bracketed paste, then press Enter. */
export async function sendText(thread: number, text: string) {
  const buf = `tgmux-${thread}`;
  tmux("set-buffer", "-b", buf, "--", text);
  tmux("paste-buffer", "-p", "-d", "-b", buf, "-t", target(thread));
  await Bun.sleep(150);
  tmux("send-keys", "-t", target(thread), "Enter");
}

/** Raw tmux key names, e.g. ["Down", "Enter"] or ["C-c"]. */
export function sendKeys(thread: number, keys: string[]) {
  return tmux("send-keys", "-t", target(thread), ...keys).ok;
}

/** The visible screen of the window, trailing blank lines removed. */
export function capture(thread: number) {
  return tmux("capture-pane", "-p", "-J", "-t", target(thread)).out.replace(/\s+$/, "");
}
