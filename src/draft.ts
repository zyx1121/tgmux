// A streamed draft (sendMessageDraft): an animated, ephemeral preview in a private chat.
// Telegram drops a draft after ~30 seconds, so a live draft is re-sent periodically until it ends.
// A paced draft types new text out in small steps instead of jumping a whole block at once.

import type { Telegram } from "./telegram";

const MIN_INTERVAL = 700;
const PACE_INTERVAL = 350;
const PACE_CATCHUP = 2000;
const PACE_MIN_STEP = 12;
const KEEPALIVE = 20_000;

/** The next text to show when moving from `shown` toward `target`: back off to the shared prefix, then add a step. */
export function paceStep(shown: string, target: string, interval = PACE_INTERVAL) {
  let common = 0;
  while (common < shown.length && common < target.length && shown[common] === target[common]) common++;
  if (common < shown.length) return target.slice(0, common);
  const backlog = target.length - common;
  const step = Math.max(PACE_MIN_STEP, Math.ceil((backlog * interval) / PACE_CATCHUP));
  let end = Math.min(target.length, common + step);
  // Do not split a surrogate pair.
  if (end < target.length && /[\uD800-\uDBFF]/.test(target[end - 1])) end++;
  return target.slice(0, end);
}

export class Draft {
  readonly id = 1 + Math.floor(Math.random() * 2_000_000_000);
  private target = "";
  private shown = "";
  private sent = 0;
  private pending: Timer | undefined;
  private keepalive: Timer | undefined;
  private ended = false;
  private caughtUp: (() => void) | undefined;
  private pace: boolean;
  private interval: number;

  constructor(
    private tg: Telegram,
    private chat: number,
    private thread: number | undefined,
    private extra: Record<string, unknown> = {},
    opts: { pace?: boolean } = {},
  ) {
    this.pace = opts.pace ?? false;
    this.interval = this.pace ? PACE_INTERVAL : MIN_INTERVAL;
  }

  /** Show text (empty = Telegram's "Thinking…" placeholder). Updates are throttled, the latest wins. */
  show(text: string) {
    if (this.ended || (text === this.target && this.sent)) return;
    this.target = text;
    if (!this.pending) this.schedule();
  }

  /** Let a paced draft type out what is left, for at most `ms`, then end it. */
  async finish(text: string, ms = 1500) {
    if (this.ended) return;
    this.show(text);
    if (this.pace && this.shown !== this.target)
      await Promise.race([new Promise<void>((r) => (this.caughtUp = r)), Bun.sleep(ms)]);
    this.end();
  }

  private schedule() {
    const wait = Math.max(0, this.sent + this.interval - Date.now());
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.push();
    }, wait);
  }

  private push() {
    if (this.ended) return;
    this.shown = this.pace ? paceStep(this.shown, this.target, this.interval) : this.target;
    this.sent = Date.now();
    const text = this.shown.length > 4000 ? `…${this.shown.slice(-3999)}` : this.shown;
    this.tg
      .call("sendMessageDraft", {
        chat_id: this.chat,
        message_thread_id: this.thread,
        draft_id: this.id,
        text,
        can_stop: true,
        ...this.extra,
      })
      .catch((e) => console.error(String(e)));
    clearTimeout(this.keepalive);
    this.keepalive = setTimeout(() => this.push(), KEEPALIVE);
    if (this.shown !== this.target) this.schedule();
    else this.caughtUp?.();
  }

  /** Stop updating; the next real message from the bot replaces the draft. */
  end() {
    this.ended = true;
    clearTimeout(this.pending);
    clearTimeout(this.keepalive);
    this.caughtUp?.();
  }

  get active() {
    return !this.ended;
  }
}
