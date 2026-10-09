// One long-lived bash for the General topic: cd, exports and functions persist between messages.

type Run = { marker: string; onData: (s: string) => void; done: (code: number) => void };

export class Shell {
  private proc: ReturnType<typeof Bun.spawn> & { stdin: import("bun").FileSink };
  private queue: Promise<unknown> = Promise.resolve();
  private current: Run | null = null;
  private buffer = "";

  constructor(private cwd: string) {
    this.proc = this.spawn();
  }

  private spawn() {
    const proc = Bun.spawn(["bash", "--noprofile", "--norc"], {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" },
    });
    this.pump(proc.stdout as ReadableStream<Uint8Array>);
    this.pump(proc.stderr as ReadableStream<Uint8Array>);
    proc.exited.then(() => {
      // The shell died (e.g. `exit`): finish the running command and start a fresh one.
      this.current?.done(-1);
      this.current = null;
      this.proc = this.spawn();
    });
    return proc;
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    for await (const bytes of stream) this.feed(decoder.decode(bytes, { stream: true }));
  }

  private feed(text: string) {
    const run = this.current;
    if (!run) return;
    this.buffer += text;
    const re = new RegExp(`${run.marker}:(-?\\d+)\\n?`);
    const m = this.buffer.match(re);
    if (m) {
      run.onData(this.buffer.slice(0, m.index));
      this.buffer = "";
      this.current = null;
      run.done(Number(m[1]));
    } else {
      // Hold back a tail that could be the start of the marker.
      const keep = run.marker.length + 8;
      if (this.buffer.length > keep) {
        run.onData(this.buffer.slice(0, -keep));
        this.buffer = this.buffer.slice(-keep);
      }
    }
  }

  /** Run one command line; resolves with its exit code. Commands run one at a time. */
  run(command: string, onData: (s: string) => void): Promise<number> {
    const task = this.queue.then(
      () =>
        new Promise<number>((done) => {
          const marker = `__TGMUX_${crypto.randomUUID().replace(/-/g, "")}`;
          this.current = { marker, onData, done };
          this.proc.stdin.write(shellLine(command, marker));
          this.proc.stdin.flush();
        }),
    );
    this.queue = task.catch(() => {});
    return task;
  }

  /** Ctrl-C equivalent: interrupt whatever the shell is running. */
  interrupt() {
    Bun.spawnSync(["pkill", "-INT", "-P", String(this.proc.pid)]);
  }
}

/** The line written to bash: the user command (base64, so quoting can't break it) plus an exit marker. */
export function shellLine(command: string, marker: string) {
  const b64 = Buffer.from(command).toString("base64");
  return `eval "$(printf %s ${b64} | base64 -d)" </dev/null 2>&1; printf '\\n${marker}:%s\\n' $?\n`;
}
