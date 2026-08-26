import type { PrismaClient } from "@rakazo/db";
import type { CdpConnection, CdpInventory } from "./cdp-connections.js";

export type SyncReport = {
  tenants: number;
  botsCreated: number;
  botsKept: number;
  toolsWithdrawn: number;
  tenantsSkipped: number;
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
          // Composio lane: the connection already lives in the connections table and
          // ComposioConnector discovers it on its own. The bot here is an organizing
          // label, not a permission boundary.
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
          // Failing to fetch a tenant's list is NOT the same as it having no connections.
          // Skip this tenant; revoking here would strip tools from every bot on every
          // CDP hiccup.
          report.tenantsSkipped += 1;
          console.error(`connection sync skipped tenant ${tenantId}:`, error);
        }
      }
      return report;
    },
  };
}
