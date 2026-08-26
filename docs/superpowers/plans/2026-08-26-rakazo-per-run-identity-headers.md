# Rakazo — danh tính theo từng run khi gọi MCP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mỗi lời gọi MCP ra ngoài mang đúng `x-tenant-id` / `x-user-id` của run đang chạy, và không có phiên nào phục vụ hai tenant.

**Architecture:** Sửa đúng một file — `packages/adapters/src/mcp-connector.ts`. Khoá cache phiên đổi từ `server.id` sang `server.id + workspaceId + userId`; hai header danh tính thêm vào `headerPolicy.headers` lúc kết nối. Vì khoá đã mang danh tính, đặt header lúc connect là an toàn — không cần wrapper `fetch` theo từng request.

**Tech Stack:** TypeScript, vitest, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-08-26-cluega-mcp-connector-design.md` (§4.4, nghiệm thu #7)

## Global Constraints

- Chỉ sửa `packages/adapters/src/mcp-connector.ts` và `packages/adapters/src/mcp-connector.test.ts` (Task 3 sửa docs). Không đụng `mcp-transport.ts`, `remote-mcp.ts`, `installed-connectors.ts`.
- Tên header viết thường, đúng chuỗi: `x-tenant-id`, `x-user-id`.
- `x-tenant-id` = `context.workspaceId`; `x-user-id` = `context.userId`. Không đổi tên, không thêm header thứ ba.
- Header do người dùng cấu hình (`material.headers`) **không được** ghi đè hai header này — danh tính đặt sau cùng.
- Chạy test: `cd packages/adapters && pnpm vitest run src/mcp-connector.test.ts`.
- Node 24 qua nvm: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.
- Transport `stdio` không có header — hai task dưới chỉ chạm nhánh remote.

---

### Task 1: Khoá cache phiên theo danh tính

Hiện `sessionFor` (mcp-connector.ts:143) khoá cache bằng `String(server.id)`, và header đặt một lần lúc connect. Cộng lại: phiên đầu tiên của workspace A sẽ được **mọi** workspace dùng lại, kèm header của A. Task 2 bơm danh tính vào header, nên khoá phải sửa **trước** — nếu không Task 2 tự tạo ra lỗ rò chéo tenant.

**Files:**
- Modify: `packages/adapters/src/mcp-connector.ts:79`, `:123`, `:134-164`
- Test: `packages/adapters/src/mcp-connector.test.ts`

**Interfaces:**
- Produces: `private sessionKey(server: McpServer, context: AdapterContext): string`
- `evict` đổi chữ ký: `private async evict(sessionKey: string): Promise<void>` (trước nhận `serverId`).

- [ ] **Step 1: Viết test thất bại**

Thêm vào cuối `describe("MCP connector session cache", ...)` trong `packages/adapters/src/mcp-connector.test.ts`:

```ts
  it("does not reuse one session across workspaces", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const contextFor = (workspaceId: string, userId: string) =>
      ({ workspaceId, userId, botId: "bot-1", signal: new AbortController().signal }) as never;

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(1);

    await connector.discoverTools(contextFor("w2", "u2"));
    expect(state.initializations).toBe(2);

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(2);

    await connector.close();
  });
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `cd packages/adapters && pnpm vitest run src/mcp-connector.test.ts -t "across workspaces"`
Expected: FAIL — `expected 1 to be 2` ở lần gọi thứ hai (phiên của w1 bị dùng lại cho w2).

- [ ] **Step 3: Sửa khoá cache**

Trong `packages/adapters/src/mcp-connector.ts`, thay khối `evict` + đầu `sessionFor`:

```ts
  private sessionKey(server: McpServer, context: AdapterContext): string {
    // Header danh tính được đặt một lần lúc connect, nên một phiên chỉ hợp lệ
    // cho đúng danh tính đã kết nối. Khoá phải mang danh tính đó.
    return `${server.id} ${context.workspaceId} ${context.userId}`;
  }

  private async evict(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    this.sessions.delete(sessionKey);
    await entry.session.close();
  }

  private async sessionFor(server: McpServer, context: AdapterContext): Promise<McpSession> {
    const sessionKey = this.sessionKey(server, context);
```

Trong phần thân còn lại của `sessionFor`, đổi hai lời gọi `this.evict(server.id)` (dòng ~150 và ~153) thành `this.evict(sessionKey)`.

Đổi hai lời gọi bên ngoài — dòng ~79 (trong `discoverTools`) và ~123 (trong `execute`) — từ `await this.evict(assignment.server.id)` thành:

```ts
      await this.evict(this.sessionKey(assignment.server, context));
```

- [ ] **Step 4: Chạy toàn bộ file test**

Run: `cd packages/adapters && pnpm vitest run src/mcp-connector.test.ts`
Expected: PASS cả hai test — test cũ ("evicts a session after a failed call") vẫn xanh, vì nó dùng một context duy nhất.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/mcp-connector.ts packages/adapters/src/mcp-connector.test.ts
git commit -m "fix: key MCP session cache by identity, not server id"
```

---

### Task 2: Bơm `x-tenant-id` / `x-user-id`

**Files:**
- Modify: `packages/adapters/src/mcp-connector.ts:203-207`
- Test: `packages/adapters/src/mcp-connector.test.ts`

**Interfaces:**
- Consumes: `sessionKey` từ Task 1 — không gọi trực tiếp, nhưng dựa vào việc một phiên chỉ phục vụ một danh tính.

- [ ] **Step 1: Viết test thất bại**

`mcpFetch` hiện bỏ qua header. Bọc nó lại để ghi header, rồi thêm test vào `packages/adapters/src/mcp-connector.test.ts`:

```ts
  it("sends the run identity on every outbound MCP request", async () => {
    const state = { failNext: false, initializations: 0 };
    const seen: Array<{ tenant: string; user: string }> = [];
    const inner = mcpFetch(state);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push({
        tenant: request.headers.get("x-tenant-id") ?? "",
        user: request.headers.get("x-user-id") ?? "",
      });
      return inner(request);
    });
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const contextFor = (workspaceId: string, userId: string) =>
      ({ workspaceId, userId, botId: "bot-1", signal: new AbortController().signal }) as never;

    await connector.discoverTools(contextFor("w1", "u1"));
    await connector.discoverTools(contextFor("w2", "u2"));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h.tenant !== "" && h.user !== "")).toBe(true);
    expect(new Set(seen.map((h) => h.tenant))).toEqual(new Set(["w1", "w2"]));

    await connector.close();
  });
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `cd packages/adapters && pnpm vitest run src/mcp-connector.test.ts -t "run identity"`
Expected: FAIL — `expected false to be true` (mọi header rỗng).

- [ ] **Step 3: Thêm hai header**

Trong `connectSession`, khối dựng `headers` (mcp-connector.ts:~203):

```ts
        const headers = {
          ...(material.headers ?? {}),
          ...(staticToken ? { Authorization: staticToken } : {}),
          // Danh tính đặt sau cùng: cấu hình của người dùng không được giả mạo tenant.
          "x-tenant-id": context.workspaceId,
          "x-user-id": context.userId,
        };
```

- [ ] **Step 4: Chạy toàn bộ file test**

Run: `cd packages/adapters && pnpm vitest run src/mcp-connector.test.ts`
Expected: PASS cả ba test.

- [ ] **Step 5: Chạy cả gói và lint**

Run: `pnpm --filter @rakazo/adapters test && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/mcp-connector.ts packages/adapters/src/mcp-connector.test.ts
git commit -m "feat: send x-tenant-id and x-user-id on outbound MCP calls"
```

---

### Task 3: Ghi lại hợp đồng danh tính

**Files:**
- Modify: `docs/pulse/TESTING.md`

- [ ] **Step 1: Thêm mục mới vào cuối `docs/pulse/TESTING.md`**

```markdown
## Kiểm danh tính theo run

Rakazo gửi `x-tenant-id` (= workspaceId) và `x-user-id` (= userId) trên mọi request MCP ra ngoài.
Cấu hình header của người dùng không ghi đè được hai cái này.

Xác nhận bằng log gateway: cho hai bot ở hai workspace gọi cùng một tool, log phải thấy hai
`x-tenant-id` khác nhau. Đây là nghiệm thu #7 của spec `2026-08-26-cluega-mcp-connector-design.md`.

Phiên MCP được cache theo `(server.id, workspaceId, userId)`. Nếu ai đó đưa khoá về lại chỉ
`server.id`, hai header trên sẽ đóng băng theo tenant kết nối đầu tiên — đó là lỗi rò chéo tenant,
không phải chuyện hiệu năng.
```

- [ ] **Step 2: Kiểm chiều dài tên tool (nghiệm thu #6 của spec)**

Với slug `cluega`, mọi tool của endpoint gộp tới runtime dưới dạng `mcp__cluega__<tên>`, và
`MAX_AGENT_TOOL_NAME_LENGTH = 64` (`packages/adapters/src/pi-runtime.ts:42`). Vượt ngưỡng là tên bị băm.
Đo ngày 26/08: tên dài nhất ra 61 ký tự. Kiểm lại sau khi gateway bật endpoint gộp:

```bash
node scripts/pulse/probe-mcp.mjs http://127.0.0.1:5235/gateway/cluega/mcp \
  | awk '{ n = length("mcp__cluega__" $1); if (n > 64) print n, $1 }'
```

Expected: không dòng nào in ra. Nếu có, đổi slug ngắn hơn trước khi bật cho người dùng — băm tên
làm hỏng mọi luật phê duyệt khớp theo tên tool.

- [ ] **Step 3: Commit**

```bash
git add docs/pulse/TESTING.md
git commit -m "docs: record the per-run MCP identity contract"
```
