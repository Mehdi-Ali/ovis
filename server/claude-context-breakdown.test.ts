import { expect, it } from "bun:test";
import { CHARS_PER_TOKEN, contextBreakdown } from "./claude-context-breakdown.ts";

const att = (body: Record<string, unknown>) => ({ type: "attachment", attachment: body });
const request = (usage: { in?: number; read?: number; write?: number }, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "assistant", timestamp: "2026-01-01T00:00:00.000Z",
  message: { model: "claude-x", content, usage: { input_tokens: usage.in ?? 0, cache_read_input_tokens: usage.read ?? 0, cache_creation_input_tokens: usage.write ?? 0 } },
  ...extra,
});
const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const chars = (n: number) => "x".repeat(n * CHARS_PER_TOKEN);
const group = (result: ReturnType<typeof contextBreakdown>, key: string) => result.groups.find((entry) => entry.key === key);

it("sums the groups to the latest request's prompt and derives the tools as the residual", () => {
  const result = contextBreakdown([
    att({ type: "prompt_snapshot", systemPrompt: [chars(100)] }),
    att({ type: "instructions", files: [{ path: "CLAUDE.md", content: chars(50) }] }),
    JSON.stringify(user(chars(10))),
    JSON.stringify(request({ read: 500 }, [{ type: "text", text: chars(20) }])),
    JSON.stringify(user(chars(30))),
    JSON.stringify(request({ read: 800 }, [{ type: "text", text: chars(40) }])),
  ]);
  expect(result.total).toBe(800);
  expect(result.estimated).toBe(true);
  expect(result.groups.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(800);
  // before the first request: system 100 + memory 50 + the first message 10 = 160 tokens, so the tools are 340
  expect(group(result, "tools")!.tokens).toBe(340);
  expect(result.groups.map((entry) => entry.tokens)).toEqual([...result.groups.map((entry) => entry.tokens)].sort((a, b) => b - a));
  expect(result.measured_at).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
});

it("counts only what follows the latest compact boundary, keeping the system prompt", () => {
  const result = contextBreakdown([
    att({ type: "prompt_snapshot", systemPrompt: [chars(10)] }),
    user(chars(1000)),
    request({ read: 2000 }, []),
    { type: "system", subtype: "compact_boundary" },
    user(chars(20)),
    request({ read: 100 }, []),
  ]);
  expect(result.total).toBe(100);
  expect(group(result, "user")!.tokens).toBe(20);
  expect(group(result, "system")).toBeDefined();
  expect(group(result, "tools")!.tokens).toBe(70);
});

it("joins a tool result to its call by id, groups MCP tools by server and Skill under skills loaded", () => {
  const result = contextBreakdown([
    request({ read: 1000 }, [
      { type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "b", name: "mcp__github__get_file", input: {} },
      { type: "tool_use", id: "c", name: "Skill", input: { skill: "tdd" } },
    ]),
    user([
      { type: "tool_result", tool_use_id: "a", content: chars(60) },
      { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: chars(30) }, { type: "image", source: {} }] },
      { type: "tool_result", tool_use_id: "c", content: chars(20) },
    ]),
    request({ read: 1200 }, []),
  ]);
  const calls = group(result, "toolcalls")!.items!;
  expect(calls.map((item) => item.label)).toEqual(["Bash", "mcp:github"]);
  expect(calls[0]!.tokens).toBeGreaterThan(calls[1]!.tokens);
  expect(group(result, "skills_loaded")!.items![0]!.label).toBe("tdd");
});

it("clamps the tool residual at zero and skips subagent requests, bad lines and synthetic replies", () => {
  const result = contextBreakdown([
    "not json",
    "",
    att({ type: "instructions", files: [{ path: "a", content: chars(500) }] }),
    request({ read: 5000 }, [], { isSidechain: true }),
    request({ read: 100 }, []),
    { type: "assistant", message: { model: "<synthetic>", content: [], usage: { input_tokens: 9000 } } },
  ]);
  expect(result.total).toBe(100);
  expect(group(result, "tools")).toBeUndefined();
  expect(group(result, "memory")!.tokens).toBe(100);
});

it("counts hooks per event and splits hook, reminder and listing attachments", () => {
  const result = contextBreakdown([
    att({ type: "hook_success", hookEvent: "SessionStart", content: chars(40) }),
    att({ type: "hook_additional_context", hookEvent: "UserPromptSubmit", content: [chars(10)] }),
    att({ type: "skill_listing", content: chars(30) }),
    att({ type: "agent_listing_delta", addedLines: [chars(5), chars(5)] }),
    att({ type: "output_style", turnReminder: chars(8) }),
    request({ read: 200 }, []),
  ]);
  expect(group(result, "hooks")!.items!.map((item) => item.label)).toEqual(["SessionStart", "UserPromptSubmit"]);
  expect(group(result, "skills_list")).toBeDefined();
  expect(group(result, "agents")).toBeDefined();
  expect(group(result, "reminders")!.items![0]!.label).toBe("output style");
});

it("answers an empty transcript with no groups", () => {
  expect(contextBreakdown([])).toEqual({ total: 0, measured_at: null, groups: [], estimated: true });
});
