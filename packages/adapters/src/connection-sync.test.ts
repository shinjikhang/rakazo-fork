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
