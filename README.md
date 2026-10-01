# Codex MCP Bridge for ChatGPT
Use ChatGPT to run Codex against projects on your own computer, keep work organized, and check progress without repeatedly copying commands and results between apps.

[Download releases](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/releases) · [Detailed setup guide](docs/setup.md) · [Security model](docs/security.md)

## What it gives you

- Run and continue local Codex work from a ChatGPT conversation.
- Organize work as reusable Agents and goal-oriented Activities instead of isolated terminal calls.
- See running work, requests needing a response, and problems from the native macOS menu-bar app or the ChatGPT status card. Select a summary count to filter current work, or open Run History. The card starts with this conversation when it has retained work, with a switch to all conversations.
- Every admitted Codex Job opens its exact Dashboard by default. While that originating card remains live, terminal completion sends one scoped follow-up to the same ChatGPT conversation and retrieves the retained exact Job result. The off-by-default experimental direct-result setting changes only newly admitted Jobs to bounded exact-Job waits; a closed or disconnected host remains a degraded state rather than a claimed wake-up capability.
- For complex choices, GPT can create a standalone HTML file for full-window comparison and local interaction. The user sends the chosen summary back to this conversation; the file does not call Bridge tools or approve Codex execution.
- Choose which project folders Codex may use, find reusable procedures through the bridge skill library, and control model, reasoning, concurrency, and access policy centrally.
- Run one Mac as the server and use another Mac as a client for status and settings.
- Keep the normal starting policy read-only and place an operator-controlled ceiling on broader access.

An opt-in authenticated HTTP [MCP Events extension](docs/mcp-events.md) provides exact Job completion webhooks and bridge-issued references for pre-approved followups. The current No Auth / Secure MCP Tunnel path cannot authorize these subscriptions. The [OAuth connection](docs/mcp-events-authentication.md) includes an access-JWT adapter and authenticated HTTP launcher. A separate opt-in [OpenAI authorization prototype](docs/mcp-events-openai-authorization.md) has passed local tests, actual ChatGPT OAuth discovery/connector creation and inner OpenAI sign-in through a temporary HTTPS trial; the composed Bridge grant and actual conversation resume acceptance remain pending. The existing completion policies remain the default.

```text
ChatGPT
  → OpenAI Secure MCP Tunnel
  → Codex MCP Bridge for ChatGPT on your server computer
  → Codex working in a registered project folder
```

## What the menu-bar app shows

On macOS, open the menu-bar icon to check the selected server without opening ChatGPT:

- **Connection and Codex usage:** server/client target, Bridge health, and—when available—weekly Codex usage remaining with its reset time.
- **Work state:** running, response-required, and issue counts, plus a conditional background-process indicator. Selecting a count filters the loaded current-work snapshot without another server read.
- **Work details:** filtered current-work lists or 12-row on-demand run history, with project, conversation, Agent, actual model, canonical lowercase reasoning effort, conditional next-run settings, snapshot work time, and background processes.
- **Quick actions:** refresh status, continue a conversation in Codex after verified connection release, open Settings, control the server, or quit the app. See [conversation connections and retention](docs/thread-lifecycle.md) for waiting reasons, persistence constraints and returning to the bridge.

<p align="center">
  <img src="docs/images/macos-menubar-usage-light-en.png" alt="English macOS menu-bar app in light appearance showing weekly Codex usage and the three current work-state counts" width="360" valign="top">
  <img src="docs/images/macos-dashboard-light-en.png" alt="English macOS menu-bar app in light appearance with Work and Run History selected, showing current Agents and their actual execution settings" width="360" valign="top">
</p>

## Choose how to use it

| Your situation | Recommended setup | What runs on this computer |
| --- | --- | --- |
| This Mac will run Codex work | macOS app in **Run Server on This Mac** mode | App, helper, Bridge, Tunnel, and Codex |
| This Mac will only manage another Mac | macOS app in **Connect to Existing Server** mode | Client app only |
| Windows or Linux will run Codex work | Node.js server | Bridge, Tunnel, and Codex |
| macOS without the native app | Node.js server | Bridge, Tunnel, and Codex |

The native client-only mode is currently available on macOS. Windows and Linux users run the Node.js server and use the ChatGPT Settings and Dashboard cards.

<p align="center">
  <img src="docs/images/macos-connection-setup-light-en.png" alt="English macOS first-run assistant in light appearance showing the local server and existing server roles" width="720">
</p>

## Quick start

### macOS app

1. Download the DMG for your Mac from [Releases](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/releases): `arm64` for Apple Silicon or `x64` for Intel.
2. Move **Codex MCP Bridge for ChatGPT** to Applications and open it.
3. Choose one role:
   - **Run Server on This Mac** to run Codex locally.
   - **Connect to Existing Server** to use this Mac only as a client.

Server mode requires macOS 13 or later, Node.js 22 or later, and `tunnel-client`. In **Settings → Codex Account & Installation**, use an existing app/terminal Codex or install a bridge-managed CLI. A single existing installation is selected automatically; saved choices and manual update preferences are preserved. The first-run assistant checks supported existing connection settings before asking for a Tunnel runtime key and Tunnel ID, then guides you through Codex browser login and the first project.

The bridge connects directly to the selected Codex through App Server. See [Codex installation and updates](docs/codex-runtimes.md) for ownership, compatibility, authentication and recovery.

Client mode does not start or require a local Bridge, Tunnel, or Codex runtime. Paste the one-time invitation copied from the server Mac, then select that saved server.

The current app is ad-hoc signed and not notarized. On first launch, macOS may require approval in **System Settings → Privacy & Security**.

### Windows, Linux, or a terminal-managed server

Install Node.js 22 or later, the Codex CLI, and `tunnel-client`, then authenticate Codex:

```bash
codex login
git clone https://github.com/menaje/codex-mcp-bridge-for-chatgpt.git
cd codex-mcp-bridge-for-chatgpt
npm ci
npm run build
```

Copy `.env.example` to the private runtime configuration location, set `CONTROL_PLANE_API_KEY` and `CONTROL_PLANE_TUNNEL_ID`, then start the server:

```bash
npm run bridge:secure
```

Use `npm run bridge:local` only for loopback development. ChatGPT access normally uses the Secure MCP Tunnel. See the [detailed setup guide](docs/setup.md) for Linux/macOS shell commands, Windows PowerShell commands, and configuration locations.

## Connect it to ChatGPT

After the server reports that the Bridge and Tunnel are ready:

1. Enable Developer mode in ChatGPT.
2. Create a developer-mode connection and choose Secure MCP Tunnel.
3. Select the Tunnel ID used by the server.
4. Choose **No Auth** for the ChatGPT connection.
5. Ask ChatGPT to open the bridge settings and register at least one project folder.

Routine computer, app, Bridge, or Tunnel restarts do not require a ChatGPT connection refresh. Refresh the connection after installing a release that changes tools or card UI.

<p align="center">
  <img src="docs/images/chatgpt-dashboard-light-en.png" alt="English ChatGPT Codex status card in light appearance showing conversation scope, three current work-state counts, Run History, and a background-process indicator" width="645">
</p>

## Settings at a glance

The resizable native Settings window separates General, Models & Execution, Projects, Codex Account & Installation, Connection, and Server in a macOS sidebar. Shared changes save automatically, server limits require an explicit apply and restart, and skill management remains in the separate **Skill Library** window. See [Native macOS app](docs/macos-app.md#settings-and-skill-management) for scope and behavior details.

Dashboard creation and same-conversation live-card completion delivery remain the default. An explicitly labeled **Experimental → Receive Codex results directly** switch is available in both Settings surfaces and is off by default. When enabled, each newly admitted Job snapshots `direct-wait`: Codex still runs asynchronously, while the current GPT run repeats bounded exact-Job waits, reviews the terminal result, and may continue only work the user already approved. Conversation changes, app backgrounding, screen lock, or connection loss do not cancel Codex, but automatic continuation through those host states is not guaranteed. macOS operational notifications remain a separate local app feature.

<p align="center">
  <img src="docs/images/chatgpt-settings-light-en.png" alt="English ChatGPT settings card in light appearance showing access strategy, execution model policy, project registration, interface language, and concurrency" width="645">
</p>

For every option and its effect, see [Setup and settings](docs/setup.md#settings-reference).

## Remote client mode

On the server Mac, open **Settings → Connection**, enable **Manage This Server from Another Mac**, and select **Create and copy a new pairing invitation valid for 5 minutes**. Paste that invitation into the client Mac. It contains the server address and security identity together, expires after five minutes, and can be used once.

<p align="center">
  <img src="docs/images/macos-pairing-invitation-light-en.png" alt="English macOS server setting in light appearance for creating and copying a five-minute one-time pairing invitation" width="720">
</p>

You can save more than one server on the client, but only one is active at a time. Switching servers changes the Dashboard and the target of shared settings. A project path entered on a client is always a path on the selected server.

Use remote management only on a private LAN or private VPN that you control. See [Remote client mode](docs/remote-client.md) for the network and security boundaries.

## Safety notes

- The Bridge binds to loopback by default and begins with read-only access.
- Project folders must be registered explicitly; the Bridge does not guess a working folder.
- Broader write or full access must be allowed by the server before a task can use it.
- This is a personal bridge for one trusted operator. Shared settings are not isolated by ChatGPT account.
- These controls are policy boundaries, not operating-system isolation. Use a separate OS user, container, VM, or disposable project copy when stronger isolation is required.
- Execution uses the selected Codex CLI through App Server. Compatibility depends on the public protocol and required features, without a bridge-owned version allowlist.

## Documentation

- [Setup and settings](docs/setup.md) — macOS server/client setup, Windows/Linux Node.js setup, ChatGPT connection, and every user-facing setting
- [Native macOS app](docs/macos-app.md) — app architecture, lifecycle, local files, recovery, and build details; [localization](docs/localization.md) and [text integrity](docs/text-integrity.md) cover generated copy and Unicode policy
- [Remote client mode](docs/remote-client.md) — pairing, server switching, network scope, and credential handling
- [ChatGPT integration](docs/chatgpt-setup.md) — connection, refresh, current tool use, and smoke checks
- [MCP 2026-07-28 migration](docs/mcp-2026-07-28-migration.md) — breaking protocol, tool-contract, and card-resource changes
- [Security model](docs/security.md) — trust boundaries, authentication, access policy, and remaining risks
- [Standalone decision HTML](docs/standalone-decision-html.md) — full-window decision aids, copyable summaries, and Codex question boundaries; [retired Decision Cards](docs/decision-cards.md) explains migration
- [Database schema and lifecycle](docs/database-schema.md) — state ownership, every table, upgrades, retention, capacity, backups, and offline compaction
- [State upgrade and recovery runbook](docs/state-upgrade-recovery.md) — release-stage profiles, migration preflight, verified restore, and post-service recovery
- [Input/output contracts](docs/input-contracts.md), [bridge skill library](docs/skills.md) — public and app-private protocol details, versioned bridge skills, model-facing lookup, and per-turn Codex delivery
- [Release process](docs/releasing.md) and [release governance](docs/release-governance.md) — maintainer workflow and distribution gates
- [UI release policy](docs/ui-release-compatibility.md) — single-file cards, stable URI versions, cache limits, and release checks

## Development

```bash
npm ci
npm run check
```

On macOS:

```bash
npm run macos:check
npm run macos:bundle
```

Release identity and supported targets are defined in `release-manifest.json`. Historical attribution is in [UPSTREAM.md](UPSTREAM.md).

## License

MIT

GPT handles ordinary Codex questions through `codex_status` (input query) and `codex_answer`. When the user’s opinion is needed, GPT asks in the current ChatGPT conversation, verifies that the original question remains valid, and sends the answer to the exact Codex turn. See [question orchestration](docs/gpt-questions.md) for the protocol, retention policy, and host validation limits.

The current card and tool contract is described in [Card tools](docs/card-tools.md). Open the Dashboard for current work and Settings to manage the bridge.
