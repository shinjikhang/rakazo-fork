import { z } from "zod";

const ConnectionRow = z.object({
  kind: z.enum(["ads", "composio"]),
  key: z.string().min(1).max(120),
  connection_id: z.string().min(1).max(200),
  connected_by_user_id: z.string().min(1).max(200),
  status: z.string().min(1).max(40),
});

export type CdpConnection = {
  kind: "ads" | "composio";
  key: string;
  connectionId: string;
  connectedByUserId: string;
  status: string;
};

export type CdpInventory = {
  listTenants(): Promise<string[]>;
  listConnections(tenantId: string): Promise<CdpConnection[]>;
};

export function createCdpInventory(options: {
  baseUrl: string;
  internalKey: string;
  fetchImpl?: typeof fetch;
}): CdpInventory {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  const get = async (path: string): Promise<unknown> => {
    const response = await doFetch(`${base}${path}`, {
      headers: { "x-internal-key": options.internalKey, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`CDP ${path} failed: ${response.status}`);
    const body = (await response.json()) as { data?: unknown };
    return body.data ?? body;
  };

  return {
    async listTenants() {
      const data = await get("/internal/v1/tenants");
      return z.array(z.string().min(1)).parse(data);
    },
    async listConnections(tenantId) {
      const data = await get(`/internal/v1/tenants/${encodeURIComponent(tenantId)}/connections`);
      const rows = z.array(z.unknown()).parse(data);
      // A row we cannot understand is dropped, not fatal for the whole list: CDP adding a
      // new platform before Rakazo knows about it is expected, not an error.
      return rows.flatMap((row) => {
        const parsed = ConnectionRow.safeParse(row);
        if (!parsed.success) return [];
        return [
          {
            kind: parsed.data.kind,
            key: parsed.data.key,
            connectionId: parsed.data.connection_id,
            connectedByUserId: parsed.data.connected_by_user_id,
            status: parsed.data.status,
          },
        ];
      });
    },
  };
}
