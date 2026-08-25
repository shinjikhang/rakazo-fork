#!/usr/bin/env node
// Chứng minh token có quyền ghi: đặt ngân sách của một ad group thành đúng giá
// trị nó đang có. Không đổi gì trên thực tế, nhưng đi hết đường ghi của API.
// Dùng: node scripts/pulse/probe-write.mjs <url> <adgroup_id> <advertiser_id>
const [url, adgroupId, advertiserId] = process.argv.slice(2);
if (!url || !adgroupId || !advertiserId) {
  console.error("dùng: probe-write.mjs <url> <adgroup_id> <advertiser_id>");
  process.exit(2);
}

let session;
async function rpc(body) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  session = res.headers.get("mcp-session-id") ?? session;
  const text = await res.text();
  const line = text
    .split("\n")
    .map((l) => l.replace(/^data:\s*/, "").trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  return line ? JSON.parse(line) : null;
}

async function callTool(name, args) {
  const out = await rpc({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } });
  if (out?.error) throw new Error(`${name}: ${JSON.stringify(out.error)}`);
  if (out?.result?.isError) throw new Error(`${name}: ${JSON.stringify(out.result.content)}`);
  return out?.result;
}

await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pulse-probe-write", version: "1" } },
});
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

const before = await callTool("tiktok_get_ad_groups", {
  advertiser_id: advertiserId,
  adgroup_ids: [adgroupId],
});
const text = JSON.stringify(before);
const match = text.match(/"budget"\s*:\s*([0-9.]+)/);
if (!match) {
  console.error("không đọc được ngân sách hiện tại:", text.slice(0, 300));
  process.exit(1);
}
const budget = Number(match[1]);
console.log(`ngân sách hiện tại: ${budget}`);

await callTool("tiktok_update_adgroup", {
  advertiser_id: advertiserId,
  adgroup_id: adgroupId,
  budget,
});
console.log("ghi được: token có quyền ghi");
