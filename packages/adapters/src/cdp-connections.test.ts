import { describe, expect, it, vi } from "vitest";
import { createCdpInventory } from "./cdp-connections.js";

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("CDP inventory client", () => {
  it("sends the internal key and parses the tenant list", async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push({ url: request.url, key: request.headers.get("x-internal-key") });
      return jsonResponse(["019e4394-f597-7839-83c9-5910622cb951"]);
    }) as unknown as typeof fetch;

    const cdp = createCdpInventory({
      baseUrl: "https://cdp.test",
      internalKey: "k",
      fetchImpl,
    });
    expect(await cdp.listTenants()).toEqual(["019e4394-f597-7839-83c9-5910622cb951"]);
    expect(seen[0]?.url).toBe("https://cdp.test/internal/v1/tenants");
    expect(seen[0]?.key).toBe("k");
  });

  it("parses connections and drops rows it cannot understand", async () => {
    const fetchImpl = (async () =>
      jsonResponse([
        {
          kind: "ads",
          key: "tiktok",
          connection_id: "c1",
          connected_by_user_id: "u1",
          status: "active",
        },
        { kind: "carrier-pigeon", key: "x", connection_id: "c2", connected_by_user_id: "u2", status: "active" },
        { kind: "composio", key: "gmail", connection_id: "c3", connected_by_user_id: "u1", status: "revoked" },
      ])) as unknown as typeof fetch;

    const cdp = createCdpInventory({ baseUrl: "https://cdp.test", internalKey: "k", fetchImpl });
    const rows = await cdp.listConnections("t1");
    expect(rows.map((row) => row.connectionId)).toEqual(["c1", "c3"]);
    expect(rows[0]?.kind).toBe("ads");
  });

  it("throws on a non-2xx so the caller can skip the tenant instead of revoking", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const cdp = createCdpInventory({ baseUrl: "https://cdp.test", internalKey: "k", fetchImpl });
    await expect(cdp.listConnections("t1")).rejects.toThrow(/500/);
  });
});
