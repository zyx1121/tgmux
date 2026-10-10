import { expect, test } from "bun:test";
import { paceStep } from "../src/draft";
import { shellLine } from "../src/shell";
import { chunk, parseCommand, stripBotSuffix } from "../src/telegram";

test("parseCommand reads command, bot suffix and args", () => {
  expect(parseCommand("/claude@zyx_tgmux_bot fix the build")).toEqual({ cmd: "claude", args: "fix the build" });
  expect(parseCommand("/screen")).toEqual({ cmd: "screen", args: "" });
  expect(parseCommand("ls -la")).toBeNull();
});

test("stripBotSuffix keeps Claude Code commands intact", () => {
  expect(stripBotSuffix("/model@zyx_tgmux_bot opus")).toBe("/model opus");
  expect(stripBotSuffix("/code-review high")).toBe("/code-review high");
  expect(stripBotSuffix("/zyx:dev-workflow")).toBe("/zyx:dev-workflow");
});

test("chunk splits on newlines under the limit", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const parts = chunk(text, 100);
  expect(parts.every((p) => p.length <= 100)).toBe(true);
  expect(parts.join("\n")).toBe(text);
});

test("shellLine survives quotes, pipes and background jobs", async () => {
  const marker = "__M";
  const cmd = `echo "a'b" | tr a A && (sleep 0 &) ; echo done`;
  const p = Bun.spawn(["bash"], { stdin: "pipe", stdout: "pipe" });
  p.stdin.write(shellLine(cmd, marker));
  p.stdin.end();
  const out = await new Response(p.stdout).text();
  expect(out).toBe(`A'b\ndone\n\n${marker}:0\n`);
});

import { buildMenu, unalias } from "../src/commands";

test("buildMenu maps Claude names onto Telegram's charset and keeps tgmux commands first", () => {
  const { menu, aliases } = buildMenu([{ command: "help", description: "tgmux" }], ["help", "code-review", "model"]);
  expect(menu.map((c) => c.command)).toEqual(["help", "code_review", "model"]);
  expect(unalias("/code_review high", aliases)).toBe("/code-review high");
  expect(unalias("/model opus", aliases)).toBe("/model opus");
});

import { chunkMarkdown } from "../src/telegram";

test("chunkMarkdown closes and reopens a code fence split across parts", () => {
  const code = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
  const parts = chunkMarkdown(`intro\n\`\`\`ts\n${code}\n\`\`\`\nouter`, 200);
  for (const p of parts) expect((p.match(/^```/gm) ?? []).length % 2).toBe(0);
  expect(parts[1].startsWith("```ts\n")).toBe(true);
});

test("paceStep types new text out in steps and backs off on rewrites", () => {
  const target = "x".repeat(600);
  let shown = "";
  let steps = 0;
  while (shown !== target) {
    const next = paceStep(shown, target);
    expect(next.length).toBeGreaterThan(shown.length);
    shown = next;
    steps++;
  }
  expect(steps).toBeGreaterThan(3);
  expect(steps).toBeLessThan(25);
  expect(paceStep("hello\n\n🔧 Bash ls", "hello world")).toBe("hello");
  expect(paceStep("ab", "ab😀c").length).toBeLessThanOrEqual(5);
  expect(paceStep("ab", "ab😀c")).not.toMatch(/[\uD800-\uDBFF]$/);
});
