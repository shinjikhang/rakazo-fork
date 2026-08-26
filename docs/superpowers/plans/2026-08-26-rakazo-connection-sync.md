# Rakazo — vòng đồng bộ kết nối và bot tự cấp phát

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rakazo tự kéo danh sách kết nối từ CDP theo chu kỳ và tạo một bot cho mỗi kết nối, thuộc về người đã nối.

**Architecture:** Một client HTTP đọc hai endpoint internal của CDP, một hàm `syncOnce` thuần làm mọi upsert trong một transaction Prisma, và một bộ hẹn giờ sao khuôn `createJobReconciler`. Cộng một thay đổi nhỏ nhưng chịu lực: bịt đường sinh user id nội bộ.

**Tech Stack:** TypeScript, Prisma, vitest, `zod` (đã có trong `@rakazo/contracts`)

**Spec:** `docs/superpowers/specs/2026-08-26-cdp-connection-sync-design.md`

Worktree: `/Users/khanghuynh/Documents/Dev/cluega/rakazo-pulse`, nhánh `feat/pulse-ad-loop`.

## Global Constraints

- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`. Test chạy từ gốc repo: `pnpm vitest run <đường dẫn file>`. Lint: `pnpm lint`.
- **`organization.id` = tenant UUID của CDP. `user.id` = `connected_by_user_id` của CDP.** Không sinh id.
- `user.email` là `NOT NULL UNIQUE`, `user.name` là `NOT NULL`. CDP không trả email → sinh `{userId}@cdp.invalid` và `name` = `userId`.
- `bots.color` là `NOT NULL` không có default. Dùng `#6A6BF5`.
- **Không có kết nối nào ≠ không lấy được danh sách.** Lỗi gọi CDP phải bỏ qua tenant đó, không thu hồi gì (nghiệm thu #9 của spec).
- Thu hồi = tắt `mcp_servers.enabled` + xoá hàng `bot_mcp_servers` + **tăng `revision`**. Thiếu `revision` thì phiên MCP cũ vẫn phục vụ tool đã thu (`mcp-connector.ts:151` so `revision`).
- Bot cấp phát **không bao giờ** `allowAllTools: true`.
- Test ngoại tuyến hoàn toàn: không gọi mạng, không cần CDP chạy.
- Làn Composio **không** tạo hàng `mcp_servers` — chỉ tạo bot. Xem §6 của spec: đó là nhóm hiển thị, không phải ranh giới quyền.

---

### Task 1: Client đọc CDP

**Files:**
- Create: `packages/adapters/src/cdp-connections.ts`
- Test: `packages/adapters/src/cdp-connections.test.ts`

**Interfaces:**
- Produces:
```ts
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
}): CdpInventory;
```

- [ ] **Step 1: Viết test thất bại**

Tạo `packages/adapters/src/cdp-connections.test.ts`:

```ts
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
    expect(seen[0].url).toBe("https://cdp.test/internal/v1/tenants");
    expect(seen[0].key).toBe("k");
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
    expect(rows[0].kind).toBe("ads");
  });

  it("throws on a non-2xx so the caller can skip the tenant instead of revoking", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const cdp = createCdpInventory({ baseUrl: "https://cdp.test", internalKey: "k", fetchImpl });
    await expect(cdp.listConnections("t1")).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `pnpm vitest run packages/adapters/src/cdp-connections.test.ts`
Expected: FAIL — không tìm thấy module `./cdp-connections.js`.

- [ ] **Step 3: Viết client**

Tạo `packages/adapters/src/cdp-connections.ts`:

```ts
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
      // Một hàng lạ bị bỏ, không làm hỏng cả danh sách: CDP thêm nền tảng mới
      // trước khi Rakazo biết về nó là chuyện bình thường.
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
```

- [ ] **Step 4: Chạy test**

Run: `pnpm vitest run packages/adapters/src/cdp-connections.test.ts`
Expected: PASS cả ba test.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/cdp-connections.ts packages/adapters/src/cdp-connections.test.ts
git commit -m "feat: client for the CDP connection inventory"
```

---

### Task 2: `syncOnce` — cấp phát và thu hồi

**Files:**
- Create: `packages/adapters/src/connection-sync.ts`
- Test: `packages/adapters/src/connection-sync.test.ts`

**Interfaces:**
- Consumes: `CdpInventory`, `CdpConnection` (Task 1).
- Produces:
```ts
export type SyncReport = {
  tenants: number;
  botsCreated: number;
  botsKept: number;
  toolsWithdrawn: number;
  tenantsSkipped: number;
};
export function createConnectionSync(
  deps: { prisma: PrismaClient; cdp: CdpInventory; gatewayMcpUrl: string },
): { syncOnce(): Promise<SyncReport> };
```

Khoá idempotent, dùng làm id của mọi hàng để chạy lại không đẻ bản ghi thứ hai:

```
bot          id = `cdpbot_${connectionId}`
mcp_servers  id = `cdpmcp_${connectionId}`
bot_mcp_servers id = `cdpbms_${connectionId}`
```

- [ ] **Step 1: Viết test thất bại**

Tạo `packages/adapters/src/connection-sync.test.ts`. Prisma được giả lập bằng một bản ghi nhận lời gọi — test này kiểm **quyết định**, không kiểm SQL:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpConnection } from "./cdp-connections.js";
import { createConnectionSync } from "./connection-sync.js";

const TENANT = "019e4394-f597-7839-83c9-5910622cb951";
const OWNER = "7f1d0c8e-0000-4000-8000-000000000001";

function adsConnection(overrides: Partial<CdpConnection> = {}): CdpConnection {
  return {
    kind: "ads",
    key: "tiktok",
    connectionId: "conn-1",
    connectedByUserId: OWNER,
    status: "active",
    ...overrides,
  };
}

function fakePrisma() {
  const upserts: Array<{ table: string; id: string; data: Record<string, unknown> }> = [];
  const table = (name: string) => ({
    upsert: vi.fn(async (args: { where: { id: string }; create: Record<string, unknown> }) => {
      upserts.push({ table: name, id: args.where.id, data: args.create });
      return args.create;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      upserts.push({ table: `${name}:update`, id: args.where.id, data: args.data });
      return args.data;
    }),
    deleteMany: vi.fn(async (args: unknown) => {
      upserts.push({ table: `${name}:deleteMany`, id: JSON.stringify(args), data: {} });
      return { count: 1 };
    }),
    findMany: vi.fn(async () => []),
  });
  const prisma = {
    organization: table("organization"),
    user: table("user"),
    member: table("member"),
    bot: table("bot"),
    mcpServer: table("mcpServer"),
    botMcpServer: table("botMcpServer"),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return { prisma, upserts };
}

describe("connection sync", () => {
  let cdp: { listTenants: ReturnType<typeof vi.fn>; listConnections: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    cdp = {
      listTenants: vi.fn(async () => [TENANT]),
      listConnections: vi.fn(async () => [adsConnection()]),
    };
  });

  it("creates a workspace, a user and one bot for an ads connection", async () => {
    const { prisma, upserts } = fakePrisma();
    const sync = createConnectionSync({
      prisma: prisma as never,
      cdp: cdp as never,
      gatewayMcpUrl: "https://gw.test/gateway/cluega/mcp",
    });

    const report = await sync.syncOnce();

    expect(report.botsCreated).toBe(1);
    const org = upserts.find((row) => row.table === "organization");
    expect(org?.id).toBe(TENANT);
    const user = upserts.find((row) => row.table === "user");
    expect(user?.id).toBe(OWNER);
    expect(user?.data.email).toBe(`${OWNER}@cdp.invalid`);
    const bot = upserts.find((row) => row.table === "bot");
    expect(bot?.id).toBe("cdpbot_conn-1");
    expect(bot?.data.workspaceId).toBe(TENANT);
    expect(bot?.data.userId).toBe(OWNER);
  });

  it("never grants allowAllTools", async () => {
    const { prisma, upserts } = fakePrisma();
    await createConnectionSync({
      prisma: prisma as never,
      cdp: cdp as never,
      gatewayMcpUrl: "https://gw.test/gateway/cluega/mcp",
    }).syncOnce();

    const assignment = upserts.find((row) => row.table === "botMcpServer");
    expect(assignment?.data.allowAllTools).toBe(false);
    expect((assignment?.data.allowedTools as string[]).length).toBeGreaterThan(0);
    expect(assignment?.data.allowedTools).toContain("tiktok_get_campaigns");
  });

  it("creates no mcp server for a composio connection", async () => {
    cdp.listConnections = vi.fn(async () => [
      adsConnection({ kind: "composio", key: "gmail", connectionId: "conn-2" }),
    ]);
    const { prisma, upserts } = fakePrisma();
    await createConnectionSync({
      prisma: prisma as never,
      cdp: cdp as never,
      gatewayMcpUrl: "https://gw.test/gateway/cluega/mcp",
    }).syncOnce();

    expect(upserts.some((row) => row.table === "bot")).toBe(true);
    expect(upserts.some((row) => row.table === "mcpServer")).toBe(false);
  });

  it("withdraws tools and bumps revision for a revoked connection, keeping the bot", async () => {
    cdp.listConnections = vi.fn(async () => [adsConnection({ status: "revoked" })]);
    const { prisma, upserts } = fakePrisma();
    const report = await createConnectionSync({
      prisma: prisma as never,
      cdp: cdp as never,
      gatewayMcpUrl: "https://gw.test/gateway/cluega/mcp",
    }).syncOnce();

    expect(report.toolsWithdrawn).toBe(1);
    expect(upserts.some((row) => row.table === "bot:update" || row.table === "bot")).toBe(true);
    const disabled = upserts.find((row) => row.table === "mcpServer:update");
    expect(disabled?.data.enabled).toBe(false);
    expect(disabled?.data.revision).toEqual({ increment: 1 });
    expect(upserts.some((row) => row.table === "botMcpServer:deleteMany")).toBe(true);
  });

  it("skips a tenant whose listing failed instead of withdrawing anything", async () => {
    cdp.listConnections = vi.fn(async () => {
      throw new Error("CDP down");
    });
    const { prisma, upserts } = fakePrisma();
    const report = await createConnectionSync({
      prisma: prisma as never,
      cdp: cdp as never,
      gatewayMcpUrl: "https://gw.test/gateway/cluega/mcp",
    }).syncOnce();

    expect(report.tenantsSkipped).toBe(1);
    expect(report.toolsWithdrawn).toBe(0);
    expect(upserts.some((row) => row.table.includes("deleteMany"))).toBe(false);
    expect(upserts.some((row) => row.table === "mcpServer:update")).toBe(false);
  });

  it("gives two people who connected the same toolkit two separate bots", async () => {
    const other = "7f1d0c8e-0000-4000-8000-000000000002";
    cdp.listConnections = vi.fn(async () => [
      adsConnection({ kind: "composio", key: "gmail", connectionId: "c-alice" }),
      adsConnection({
        kind: "composio",
        key: "gmail",
        connectionId: "c-bob",
        connectedByUserId: other,
      }),
    ]);
    const { prisma, upserts } = fakePrisma();
    const report = await createConnectionSync({
      prisma: prisma as never,
      cdp: cdp as never,
      gatewayMcpUrl: "https://gw.test/gateway/cluega/mcp",
    }).syncOnce();

    expect(report.botsCreated).toBe(2);
    const owners = upserts.filter((row) => row.table === "bot").map((row) => row.data.userId);
    expect(new Set(owners)).toEqual(new Set([OWNER, other]));
  });

  it("running twice does not create a second bot", async () => {
    const { prisma, upserts } = fakePrisma();
    const sync = createConnectionSync({
      prisma: prisma as never,
      cdp: cdp as never,
      gatewayMcpUrl: "https://gw.test/gateway/cluega/mcp",
    });
    await sync.syncOnce();
    await sync.syncOnce();

    const botIds = upserts.filter((row) => row.table === "bot").map((row) => row.id);
    expect(botIds).toEqual(["cdpbot_conn-1", "cdpbot_conn-1"]);
    expect(new Set(botIds).size).toBe(1);
  });

  it("does nothing for a tenant with no connections", async () => {
    cdp.listConnections = vi.fn(async () => []);
    const { prisma, upserts } = fakePrisma();
    const report = await createConnectionSync({
      prisma: prisma as never,
      cdp: cdp as never,
      gatewayMcpUrl: "https://gw.test/gateway/cluega/mcp",
    }).syncOnce();

    expect(report.botsCreated).toBe(0);
    expect(upserts.some((row) => row.table === "bot")).toBe(false);
  });
});
```

- [ ] **Step 3: Chạy để xác nhận thất bại**

Run: `pnpm vitest run packages/adapters/src/connection-sync.test.ts`
Expected: FAIL — không tìm thấy module `./connection-sync.js`.

- [ ] **Step 4: Viết `connection-sync.ts`**

```ts
import type { PrismaClient } from "@rakazo/db";
import type { CdpConnection, CdpInventory } from "./cdp-connections.js";

export type SyncReport = {
  tenants: number;
  botsCreated: number;
  botsKept: number;
  toolsWithdrawn: number;
  tenantsSkipped: number;
};

// Tool của mỗi nền tảng, theo tiền tố tên tool trên endpoint gộp. Đo 26/08:
// 246 tool tiktok_, 110 tool facebook_, 12 tool cluega_tiktok_ad_manager_.
// Ba tool cấp gateway không thuộc nền tảng nào nên có mặt ở mọi bot quảng cáo.
const GATEWAY_TOOLS = ["ask_clarification", "recommend_ad_creatives", "search_knowledge_base"];
const ADS_TOOL_PREFIXES: Record<string, string[]> = {
  tiktok: ["tiktok_", "cluega_tiktok_ad_manager_"],
  "tiktok-shop": ["tiktok_shop_"],
  facebook: ["facebook_"],
  "google-ads": ["google_"],
};

// Tên tool cụ thể phải đến từ tools/list lúc chạy; ở đây giữ một tập hạt giống
// đủ để bot dùng được ngay, và vòng đồng bộ sau sẽ mở rộng khi biết thêm.
// Cố ý KHÔNG dùng allowAllTools: xem §6 của spec.
const ADS_SEED_TOOLS: Record<string, string[]> = {
  tiktok: [
    "tiktok_get_campaigns",
    "tiktok_get_adgroups",
    "tiktok_get_ads",
    "tiktok_get_business_centers",
    "cluega_tiktok_ad_manager_advertiser_list",
    "cluega_tiktok_ad_manager_report_daily_summary",
  ],
  "tiktok-shop": ["tiktok_shop_get_shops"],
  facebook: ["facebook_get_campaigns", "facebook_get_adsets", "facebook_get_ads"],
  "google-ads": ["google_get_campaigns"],
};

function botName(connection: CdpConnection): string {
  return connection.kind === "ads" ? `${connection.key} (CDP)` : connection.key;
}

function allowedToolsFor(connection: CdpConnection): string[] {
  const seed = ADS_SEED_TOOLS[connection.key] ?? [];
  return [...seed, ...GATEWAY_TOOLS];
}

export function createConnectionSync(deps: {
  prisma: PrismaClient;
  cdp: CdpInventory;
  gatewayMcpUrl: string;
}) {
  const syncTenant = async (tenantId: string, report: SyncReport): Promise<void> => {
    const connections = await deps.cdp.listConnections(tenantId);

    for (const connection of connections) {
      const now = new Date();
      const botId = `cdpbot_${connection.connectionId}`;
      const serverId = `cdpmcp_${connection.connectionId}`;
      const assignmentId = `cdpbms_${connection.connectionId}`;
      const owner = connection.connectedByUserId;

      await deps.prisma.$transaction(async (tx) => {
        await tx.organization.upsert({
          where: { id: tenantId },
          create: { id: tenantId, name: "CDP", slug: `cdp-${tenantId}`, createdAt: now },
          update: {},
        });
        // Email và name là NOT NULL bên Rakazo; CDP không tra được email theo id
        // (usecase/auth/port.go chỉ có VerifyToken), nên sinh ra một giá trị
        // không bao giờ trùng. Rakazo không có trang đăng nhập.
        await tx.user.upsert({
          where: { id: owner },
          create: {
            id: owner,
            name: owner,
            email: `${owner}@cdp.invalid`,
            emailVerified: false,
            createdAt: now,
            updatedAt: now,
          },
          update: {},
        });
        await tx.member.upsert({
          where: { id: `cdpmem_${tenantId}_${owner}` },
          create: {
            id: `cdpmem_${tenantId}_${owner}`,
            organizationId: tenantId,
            userId: owner,
            role: "owner",
            createdAt: now,
          },
          update: {},
        });
        await tx.bot.upsert({
          where: { id: botId },
          create: {
            id: botId,
            workspaceId: tenantId,
            userId: owner,
            name: botName(connection),
            title: connection.key,
            description: "",
            instructions: "",
            color: "#6A6BF5",
            updatedAt: now,
          },
          update: {},
        });

        if (connection.kind !== "ads") {
          // Làn Composio: kết nối đã nằm ở bảng connections và ComposioConnector
          // tự phát hiện. Bot ở đây là nhãn tổ chức, không phải ranh giới quyền.
          return;
        }

        if (connection.status !== "active") {
          await tx.mcpServer.update({
            where: { id: serverId },
            data: { enabled: false, revision: { increment: 1 }, updatedAt: now },
          });
          await tx.botMcpServer.deleteMany({ where: { id: assignmentId } });
          return;
        }

        await tx.mcpServer.upsert({
          where: { id: serverId },
          create: {
            id: serverId,
            workspaceId: tenantId,
            userId: owner,
            slug: "cluega",
            name: "Cluega MCP",
            description: "",
            transport: "streamable_http",
            endpoint: deps.gatewayMcpUrl,
            args: [],
            env: {},
            headers: {},
            enabled: true,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          },
          update: { enabled: true, endpoint: deps.gatewayMcpUrl, updatedAt: now },
        });
        await tx.botMcpServer.upsert({
          where: { id: assignmentId },
          create: {
            id: assignmentId,
            workspaceId: tenantId,
            botId,
            serverId,
            userId: owner,
            allowAllTools: false,
            allowedTools: allowedToolsFor(connection),
            createdAt: now,
            updatedAt: now,
          },
          update: { allowAllTools: false, allowedTools: allowedToolsFor(connection), updatedAt: now },
        });
      });

      if (connection.kind === "ads" && connection.status !== "active") report.toolsWithdrawn += 1;
      else report.botsCreated += 1;
    }
  };

  return {
    async syncOnce(): Promise<SyncReport> {
      const report: SyncReport = {
        tenants: 0,
        botsCreated: 0,
        botsKept: 0,
        toolsWithdrawn: 0,
        tenantsSkipped: 0,
      };
      const tenants = await deps.cdp.listTenants();
      report.tenants = tenants.length;
      for (const tenantId of tenants) {
        try {
          await syncTenant(tenantId, report);
        } catch (error) {
          // Không lấy được danh sách KHÁC với không có kết nối nào. Bỏ qua tenant
          // này; thu hồi ở đây sẽ xoá tool của mọi bot mỗi lần CDP hiccup.
          report.tenantsSkipped += 1;
          console.error(`connection sync skipped tenant ${tenantId}:`, error);
        }
      }
      return report;
    },
  };
}
```

- [ ] **Step 5: Chạy test**

Run: `pnpm vitest run packages/adapters/src/connection-sync.test.ts`
Expected: PASS cả tám test.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/connection-sync.ts packages/adapters/src/connection-sync.test.ts
git commit -m "feat: sync CDP connections into provisioned bots"
```

---

### Task 3: Bộ hẹn giờ và nối vào worker

**Files:**
- Modify: `packages/adapters/src/connection-sync.ts`
- Modify: `packages/adapters/src/index.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/api/src/env.ts`
- Test: `packages/adapters/src/connection-sync.test.ts`

**Interfaces:**
- Produces: `createConnectionSync` trả thêm `start()` và `stop()`, sao khuôn `createJobReconciler` (`packages/adapters/src/job-reconciler.ts:250-262`).

- [ ] **Step 1: Viết test thất bại**

Thêm vào `packages/adapters/src/connection-sync.test.ts`:

```ts
  it("does not overlap two syncs", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    cdp.listTenants = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return [];
    });
    const { prisma } = fakePrisma();
    const sync = createConnectionSync({
      prisma: prisma as never,
      cdp: cdp as never,
      gatewayMcpUrl: "https://gw.test/gateway/cluega/mcp",
    });
    await Promise.all([sync.syncOnce(), sync.syncOnce()]);
    expect(maxInFlight).toBe(1);
  });
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `pnpm vitest run packages/adapters/src/connection-sync.test.ts -t "overlap"`
Expected: FAIL — `expected 2 to be 1`.

- [ ] **Step 3: Thêm chống chồng và bộ hẹn giờ**

Trong `connection-sync.ts`, đổi phần `return` thành, và cho `options` vào chữ ký:

```ts
export function createConnectionSync(
  deps: { prisma: PrismaClient; cdp: CdpInventory; gatewayMcpUrl: string },
  options: { intervalMs?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<SyncReport> | undefined;
```

và:

```ts
  const syncOnce = (): Promise<SyncReport> => {
    if (running) return running;
    running = (async () => {
      /* thân hàm syncOnce cũ ở đây */
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    syncOnce,
    start() {
      if (timer) return;
      void syncOnce().catch((error) => console.error("connection sync", error));
      timer = setInterval(
        () => void syncOnce().catch((error) => console.error("connection sync", error)),
        intervalMs,
      );
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
}
```

- [ ] **Step 4: Chạy toàn bộ file test**

Run: `pnpm vitest run packages/adapters/src/connection-sync.test.ts`
Expected: PASS cả chín test.

- [ ] **Step 5: Xuất và nối vào worker**

Thêm vào `packages/adapters/src/index.ts`:

```ts
export { createCdpInventory } from "./cdp-connections.js";
export type { CdpConnection, CdpInventory } from "./cdp-connections.js";
export { createConnectionSync } from "./connection-sync.js";
export type { SyncReport } from "./connection-sync.js";
```

Trong `apps/worker/src/index.ts`, cạnh chỗ dựng `jobHandlers` (~dòng 117), thêm — chỉ khi cấu hình đủ, im lặng bỏ qua khi thiếu:

```ts
  const cdpBaseUrl = process.env.CDP_BASE_URL;
  const cdpInternalKey = process.env.CDP_INTERNAL_API_KEY;
  const gatewayMcpUrl = process.env.CLUEGA_GATEWAY_MCP_URL;
  const connectionSync =
    cdpBaseUrl && cdpInternalKey && gatewayMcpUrl
      ? createConnectionSync({
          prisma,
          cdp: createCdpInventory({ baseUrl: cdpBaseUrl, internalKey: cdpInternalKey }),
          gatewayMcpUrl,
        })
      : undefined;
  connectionSync?.start();
```

Và trong đường tắt của worker, gọi `await connectionSync?.stop()` cạnh những `stop()` khác — tìm bằng `grep -n "stop()" apps/worker/src/index.ts`.

- [ ] **Step 6: Ghi biến môi trường**

Thêm ba dòng vào `.env.example` ở gốc repo, kèm chú thích một dòng:

```
# Đồng bộ kết nối từ CDP (bỏ trống thì vòng đồng bộ không chạy)
CDP_BASE_URL=
CDP_INTERNAL_API_KEY=
CLUEGA_GATEWAY_MCP_URL=
```

- [ ] **Step 7: Build, test, lint**

Run: `pnpm build && pnpm vitest run packages/adapters && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/adapters/src/connection-sync.ts packages/adapters/src/index.ts apps/worker/src/index.ts .env.example
git commit -m "feat: run the connection sync loop in the worker"
```

---

### Task 4: Bịt đường sinh user id nội bộ

Đây là phần chịu lực của cả thiết kế, và nó nhỏ. `user.id` phải là id của CDP; nếu Rakazo còn tự sinh được user thì bệnh hai không gian tên quay lại. Một quy tắc ghi trong spec sẽ trôi; một đường bị bịt thì không.

**Files:**
- Modify: `packages/auth/src/index.ts:144`
- Test: `packages/auth/src/index.test.ts`

- [ ] **Step 1: Viết test thất bại**

Thêm vào `packages/auth/src/index.test.ts`:

```ts
  it("blocks local sign-up so user ids can only come from CDP", () => {
    expect(blockedAuthPaths).toContain("/sign-up/email");
    expect(blockedAuthPaths.some((path) => path.includes("sign-up"))).toBe(true);
  });
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `pnpm vitest run packages/auth/src/index.test.ts`
Expected: FAIL — danh sách không có `/sign-up/email`.

- [ ] **Step 3: Bịt đường**

Trong `packages/auth/src/index.ts`, thêm vào `blockedAuthPaths` (dòng 144):

```ts
export const blockedAuthPaths = [
  "/organization/create",
  "/organization/invite",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
  // user.id PHẢI là user id của CDP: nó là chuỗi mà Composio dùng để tra kết nối
  // OAuth, và là x-user-id gửi lên gateway. Đăng ký tại chỗ sinh ra một id thứ
  // hai cho cùng một con người, và kết nối của họ trở thành vô hình.
  "/sign-up/email",
  "/sign-up",
];
```

- [ ] **Step 4: Chạy test**

Run: `pnpm vitest run packages/auth/src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Kiểm không làm hỏng đăng nhập**

Run: `pnpm vitest run packages/auth apps/api`
Expected: PASS. Nếu có test nào tạo user qua đường sign-up, sửa nó để tạo hàng `user` trực tiếp qua Prisma — **đừng** bỏ đường bịt để test xanh.

- [ ] **Step 6: Commit**

```bash
git add packages/auth/src/index.ts packages/auth/src/index.test.ts
git commit -m "fix: block local sign-up so user ids come only from CDP"
```

---

### Task 5: Ghi lại vận hành

**Files:**
- Modify: `docs/pulse/TESTING.md`

- [ ] **Step 1: Thêm mục vào cuối `docs/pulse/TESTING.md`**

```markdown
## Vòng đồng bộ kết nối

Worker kéo `GET /internal/v1/tenants` và `GET /internal/v1/tenants/{t}/connections` của CDP mỗi 5
phút, rồi tạo một bot cho mỗi kết nối. Không chạy nếu thiếu `CDP_BASE_URL`,
`CDP_INTERNAL_API_KEY` hoặc `CLUEGA_GATEWAY_MCP_URL`.

Chạy tay một vòng để khỏi chờ:

    node -e 'import("@rakazo/adapters").then(async (m) => {
      const { createDb } = await import("@rakazo/db/client");
      const { prisma } = createDb(process.env.DATABASE_URL);
      const cdp = m.createCdpInventory({ baseUrl: process.env.CDP_BASE_URL, internalKey: process.env.CDP_INTERNAL_API_KEY });
      console.log(await m.createConnectionSync({ prisma, cdp, gatewayMcpUrl: process.env.CLUEGA_GATEWAY_MCP_URL }).syncOnce());
    })'

Kiểm sau khi chạy:

    select b.name, m."allowAllTools", jsonb_array_length(m."allowedTools")
      from bot_mcp_servers m join bots b on b.id = m."botId";

`allowAllTools` phải là `f` ở mọi hàng. Nếu thấy `t`, có ai đó cấp phát bằng tay — không phải vòng
đồng bộ.

**Hai điều dễ hiểu sai.** Bot của làn Composio là **nhãn hiển thị**, không phải ranh giới quyền:
mọi bot của cùng một người đều thấy tool của mọi kết nối Composio của người đó (§6 của spec). Và
`tenantsSkipped > 0` trong báo cáo nghĩa là CDP không trả lời cho tenant đó — đúng như thiết kế, vòng
đồng bộ **không** thu hồi gì trong trường hợp đó.
```

- [ ] **Step 2: Commit**

```bash
git add docs/pulse/TESTING.md
git commit -m "docs: how to run and check the connection sync loop"
```
