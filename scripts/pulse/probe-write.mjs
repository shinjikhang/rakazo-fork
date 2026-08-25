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
  const out = await rpc({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (out?.error) throw new Error(`${name}: ${JSON.stringify(out.error)}`);
  if (out?.result?.isError) throw new Error(`${name}: ${JSON.stringify(out.result.content)}`);
  return out?.result;
}

await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pulse-probe-write", version: "1" },
  },
});
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

function payloadOf(result) {
  // Kết quả MCP về dưới dạng content[].text; nội dung là JSON của API TikTok.
  const texts = (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text);
  for (const text of texts) {
    try {
      return JSON.parse(text);
    } catch {
      // không phải JSON: thử phần text tiếp theo
    }
  }
  return result?.structuredContent ?? null;
}

function findRows(node, depth = 0) {
  if (depth > 6 || node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.filter((r) => r && typeof r === "object");
  if (Array.isArray(node.list)) return node.list.filter((r) => r && typeof r === "object");
  for (const value of Object.values(node)) {
    const found = findRows(value, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

// tiktok_get_ad_groups chỉ nhận advertiser_id (bắt buộc) và filters — một chuỗi
// JSON; lọc theo id cụ thể đi qua filters (đã kiểm bằng tools/list).
const before = await callTool("tiktok_get_ad_groups", {
  advertiser_id: advertiserId,
  filters: JSON.stringify({ adgroup_ids: [adgroupId] }),
});
const rows = findRows(payloadOf(before));
const row = rows.find((r) => String(r.adgroup_id) === String(adgroupId));
if (!row) {
  console.error(`không thấy ad group ${adgroupId} trong kết quả đọc`);
  process.exit(1);
}
const budget = Number(row.budget);
if (!Number.isFinite(budget)) {
  console.error(`không đọc được ngân sách hiện tại của ${adgroupId}: budget=${String(row.budget)}`);
  process.exit(1);
}
console.log(`ngân sách hiện tại: ${budget}`);

// tiktok_update_adgroup chỉ có advertiser_id/adgroup_id/params ở top level;
// budget đi trong params dạng chuỗi JSON.
await callTool("tiktok_update_adgroup", {
  advertiser_id: advertiserId,
  adgroup_id: adgroupId,
  params: JSON.stringify({ budget }),
});
console.log("ghi được: token có quyền ghi");
