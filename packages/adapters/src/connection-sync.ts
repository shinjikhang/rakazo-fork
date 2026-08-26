import type { PrismaClient } from "@rakazo/db";
import type { CdpConnection, CdpInventory } from "./cdp-connections.js";

export type SyncReport = {
  tenants: number;
  botsCreated: number;
  botsKept: number;
  toolsWithdrawn: number;
  tenantsSkipped: number;
  connectionsFailed: number;
};

// Tools per platform, by the tool-name prefix on the merged gateway endpoint. Measured
// 2026-08-26: 246 tiktok_ tools, 110 facebook_ tools, 12 cluega_tiktok_ad_manager_ tools.
// The three gateway-level tools belong to no platform, so every ads bot gets them.
const GATEWAY_TOOLS = ["ask_clarification", "recommend_ad_creatives", "search_knowledge_base"];

// Seed tool names have to come from tools/list at run time eventually; this keeps a seed set
// large enough for the bot to be usable right away, and a later sync widens it as more is
// known. Deliberately NOT allowAllTools: see spec §6.
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

export function createConnectionSync(
  deps: { prisma: PrismaClient; cdp: CdpInventory; gatewayMcpUrl: string },
  options: { intervalMs?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<SyncReport> | undefined;

  const syncTenant = async (tenantId: string, report: SyncReport): Promise<void> => {
    const connections = await deps.cdp.listConnections(tenantId);

    // Every ads connection of the same owner shares one mcp_servers row (they all point at
    // the same aggregate gateway endpoint); mcp_servers has a unique (workspaceId, userId,
    // slug) index, so a second row for the same owner would collide. Per-connection scoping
    // lives in bot_mcp_servers instead. Used to decide, on a revoke, whether any *other*
    // active ads connection of this owner still needs the shared server enabled.
    const ownerHasActiveAds = (owner: string) =>
      connections.some(
        (c) => c.kind === "ads" && c.status === "active" && c.connectedByUserId === owner,
      );
    // Every active connection of the same owner would otherwise upsert the identical shared
    // row again; resolve it once per owner and reuse. The resolved id is the row's REAL id,
    // which may differ from our deterministic `serverId` guess if an existing row (stale or
    // manually made) already owned the (workspace, owner, "cluega") tuple and got adopted.
    const resolvedServerId = new Map<string, string>();

    for (const connection of connections) {
      try {
        const now = new Date();
        const botId = `cdpbot_${connection.connectionId}`;
        const serverId = `cdpmcp_${tenantId}_${connection.connectedByUserId}`;
        const assignmentId = `cdpbms_${connection.connectionId}`;
        const owner = connection.connectedByUserId;

        await deps.prisma.$transaction(async (tx) => {
          await tx.organization.upsert({
            where: { id: tenantId },
            create: { id: tenantId, name: "CDP", slug: `cdp-${tenantId}`, createdAt: now },
            update: {},
          });
          // email and name are NOT NULL on Rakazo's side; CDP has no way to look up an
          // email by id, so we generate a value that can never collide. Rakazo has no
          // sign-in page of its own for these accounts.
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
          // A member row for this (org, user) pair may already exist under a different id
          // (a manual invite, or a row from before this sync loop existed): look it up by
          // the real unique tuple so we adopt it instead of colliding on create.
          await tx.member.upsert({
            where: { organizationId_userId: { organizationId: tenantId, userId: owner } },
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
            // Composio lane: the connection already lives in the connections table and
            // ComposioConnector discovers it on its own. The bot here is an organizing
            // label, not a permission boundary.
            return;
          }

          if (connection.status !== "active") {
            // The shared server row stays enabled if the owner has another active ads
            // connection; only turn it off once nothing of theirs needs it. Bump revision
            // either way so a cached MCP session for this owner drops the withdrawn tools
            // (mcp-connector.ts:151). Looked up by the real unique tuple, not our
            // deterministic id, in case this row was adopted from a pre-existing one — and
            // read back its real id, since bot_mcp_servers.serverId may point at that real
            // id rather than our guess.
            const server = await tx.mcpServer.update({
              where: {
                workspaceId_userId_slug: { workspaceId: tenantId, userId: owner, slug: "cluega" },
              },
              data: {
                revision: { increment: 1 },
                updatedAt: now,
                ...(ownerHasActiveAds(owner) ? {} : { enabled: false }),
              },
            });
            // Withdraw only this connection's tool grant. Match on (botId, serverId), not
            // assignmentId: a pre-existing assignment for this exact bot+server pair may
            // carry a different id than our deterministic one.
            await tx.botMcpServer.deleteMany({ where: { botId, serverId: server.id } });
            return;
          }

          let realServerId = resolvedServerId.get(owner);
          if (!realServerId) {
            // A server row for this (workspace, owner, "cluega") tuple may already exist
            // under a different id (a stale row from before this sync shared one row per
            // owner, or a manually created one): look it up by the real unique tuple so we
            // adopt it instead of colliding on create. Keep a deterministic `id` in the
            // create branch only so a fresh row is still recognisable, and read back
            // whichever id actually won (ours, or the adopted row's).
            const server = await tx.mcpServer.upsert({
              where: {
                workspaceId_userId_slug: { workspaceId: tenantId, userId: owner, slug: "cluega" },
              },
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
            realServerId = server.id;
            resolvedServerId.set(owner, realServerId);
          }
          // Same reasoning as the server row: a pre-existing assignment for this exact
          // (botId, serverId) pair may carry a different id.
          await tx.botMcpServer.upsert({
            where: { botId_serverId: { botId, serverId: realServerId } },
            create: {
              id: assignmentId,
              workspaceId: tenantId,
              botId,
              serverId: realServerId,
              userId: owner,
              allowAllTools: false,
              allowedTools: allowedToolsFor(connection),
              createdAt: now,
              updatedAt: now,
            },
            update: {
              allowAllTools: false,
              allowedTools: allowedToolsFor(connection),
              updatedAt: now,
            },
          });
        });

        if (connection.kind === "ads" && connection.status !== "active") report.toolsWithdrawn += 1;
        else report.botsCreated += 1;
      } catch (error) {
        // One connection's failure (a unique-constraint collision, a transient DB error)
        // must not cost its siblings: count it and move on to the next connection.
        report.connectionsFailed += 1;
        console.error(`connection sync failed for connection ${connection.connectionId}:`, error);
      }
    }
  };

  const syncOnce = (): Promise<SyncReport> => {
    if (running) return running;
    running = (async () => {
      const report: SyncReport = {
        tenants: 0,
        botsCreated: 0,
        botsKept: 0,
        toolsWithdrawn: 0,
        tenantsSkipped: 0,
        connectionsFailed: 0,
      };
      const tenants = await deps.cdp.listTenants();
      report.tenants = tenants.length;
      for (const tenantId of tenants) {
        try {
          await syncTenant(tenantId, report);
        } catch (error) {
          // Failing to fetch a tenant's list is NOT the same as it having no connections.
          // Skip this tenant; revoking here would strip tools from every bot on every
          // CDP hiccup.
          report.tenantsSkipped += 1;
          console.error(`connection sync skipped tenant ${tenantId}:`, error);
        }
      }
      return report;
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
