import { expect, test } from "bun:test";
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
