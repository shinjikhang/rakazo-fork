#!/usr/bin/env node
// Gọi thử MỘT tool MCP và in kết quả thô.
//
// Vì sao cần script này: tools/list chạy được mà không cần auth, tools/call thì
// không. probe-mcp.mjs chỉ liệt kê, nên nó báo xanh trong khi đường dữ liệu vẫn
// tắc. Đây là phép thử duy nhất chứng minh tool trả về dữ liệu thật.
//
// Dùng: node scripts/pulse/call-tool.mjs <url> <tool> ['<json args>'] [-H 'Header: value']
const argv = process.argv.slice(2);
const headers = {};
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "-H" && argv[i + 1]) {
    const raw = argv[i + 1];
    const at = raw.indexOf(":");
    if (at > 0) headers[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
    i += 1;
  } else positional.push(argv[i]);
}
const [url, tool, argsJson] = positional;
if (!url || !tool) {
  console.error(
    "dùng: call-tool.mjs <url> <tool> ['<json args>'] [-H 'Authorization: Bearer ...']",
  );
  process.exit(2);
}

let session;
async function rpc(body) {
  const h = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  };
  if (session) h["mcp-session-id"] = session;
  const res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(body) });
  session = res.headers.get("mcp-session-id") ?? session;
  const text = await res.text();
  if (!res.ok && !text.trim().startsWith("{") && !text.includes("data:")) {
    console.error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const line = text
    .split("\n")
    .map((l) => l.replace(/^data:\s*/, "").trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  return line ? JSON.parse(line) : { _status: res.status, _raw: text.slice(0, 300) };
}

await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pulse-call-tool", version: "1" },
  },
});
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
const out = await rpc({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: tool, arguments: JSON.parse(argsJson || "{}") },
});

console.log(JSON.stringify(out, null, 1));
// isError của MCP là lỗi ở tầng tool, không phải lỗi truyền tải — phải thoát ≠0
if (out?.result?.isError || out?.error) process.exit(1);
