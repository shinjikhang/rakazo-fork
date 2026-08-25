#!/usr/bin/env node
// Dò một MCP server streamable-HTTP và kiểm tra các tool bắt buộc có mặt.
// Dùng: node scripts/pulse/probe-mcp.mjs <url> <tool1> <tool2> ...
const [url, ...required] = process.argv.slice(2);
if (!url) {
  console.error("dùng: probe-mcp.mjs <url> [tool bắt buộc...]");
  process.exit(2);
}

async function rpc(body, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const line = text
    .split("\n")
    .map((l) => l.replace(/^data:\s*/, "").trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  return { session: res.headers.get("mcp-session-id") ?? sessionId, json: line ? JSON.parse(line) : null };
}

const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pulse-probe", version: "1" },
  },
});
const session = init.session;
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session);

const names = (listed.json?.result?.tools ?? []).map((t) => t.name);
console.log(`tổng: ${names.length}`);
const missing = required.filter((r) => !names.includes(r));
if (missing.length > 0) {
  console.error(`thiếu: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(required.length > 0 ? `đủ ${required.length} tool bắt buộc` : names.join("\n"));
