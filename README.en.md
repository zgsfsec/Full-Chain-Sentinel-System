# Full Chain Sentinel System

**English** | [简体中文](README.md) · **Version 2.3.0**

An authorized penetration-testing agent by Zhigong Shanfang Lab, built on [pi](https://github.com/earendil-works/pi). A bilingual web console brings Web, mini-program, and mobile testing together with project environments, approval, and evidence management.

> **Use only against targets for which you hold written authorization.** Auto mode can run arbitrary commands; operators are responsible for the consequences. Read the [authorized-use statement and security boundaries](docs/security.en.md) before use.

[Community](#community) · [Quick start](#quick-start) · [Capabilities](#capabilities) · [Documentation](#documentation) · [License](#license)

<a id="community"></a>

## Full Chain Sentinel community

Include **"全链哨兵"** in your greeting when joining.

<p>
  <img src="images/community-contact-1.png" width="260" alt="Full Chain Sentinel community contact one" />
  <img src="images/community-contact-2.png" width="260" alt="Full Chain Sentinel community contact two" />
</p>

[Community details and acknowledgements](docs/community.en.md)

---

<a id="quick-start"></a>

## Quick start

### 1. Download and start

Install and start Docker. Download the archive for your operating system and architecture from [Releases](https://github.com/zgsfsec/Full-Chain-Sentinel-System/releases).

Linux x64 example:

```sh
tar -xzf sentinel-web-linux-x64.tar.gz
cd sentinel-web
chmod +x sentinel-web
./sentinel-web
```

On Windows, extract `sentinel-web-windows-x64.zip` and run `.\sentinel-web.exe` in PowerShell. Keep the `replayd/` directory next to the executable.

### 2. Set up the console

Open the **complete entry URL** printed at startup. Create an account, accept the authorized-use statement, prepare the tool image under Settings → Environment, and add an endpoint and assign the main model under Settings → Models. Then create a project.

New projects have a work container and a persistent gateway. Switching proxies does not recreate the work container.

### 3. Start testing

Describe your authorized scope and target in the conversation. Approval mode is the default. For mobile testing, connect a device first and enable its tools in the current conversation.

[Deployment and startup flags](docs/deployment.en.md) · [Run from source](docs/deployment.en.md#section-2) · [Usage guide](docs/usage.en.md) · [Device setup](docs/mobile.en.md)

---

<a id="capabilities"></a>

## Capabilities

The screenshots below come from the complete console running the current **v2.2.13 source**, using a separate local project and the real backend and Docker containers. Unconfigured models, empty records, and disconnected devices are shown as captured. [Capture details](images/screenshots/README.md).

### 1. Project overview

See running tasks, pending approvals, findings, and conversations for the active project, with shortcuts from recent conversations and status panels.

![Project overview](images/screenshots/dashboard.png)

### 2. Conversations and persistent goals

Stream replies, reasoning, and tool activity; use conversation branches, files, a terminal, and subagents. Choose approval mode, presets, supervision, and device tools in the composer. Persistent goals continue in Auto or AI Approval mode.

![Conversation workspace and tool controls](images/screenshots/chat.png)

### 3. Projects and proxies

Projects isolate workspaces, containers, conversations, and findings. New projects use a Kali work container and persistent gateway. Manage SOCKS5/HTTP, subscriptions, WireGuard, and OpenVPN profiles and switch project exits at runtime.

<details>
<summary>View screenshots</summary>

![Projects and container management](images/screenshots/projects.png)

![Proxy profiles](images/screenshots/proxies.png)

</details>

### 4. Findings and asset library

Filter and review finding severity, CVSS, status, and evidence, then export Markdown reports. The asset library merges domains, IPs, services, and URLs per project, with tags, test notes, and linked findings.

<details>
<summary>View screenshots</summary>

![Finding filters and review](images/screenshots/vulnerabilities.png)

![Asset library and test records](images/screenshots/assets.png)

</details>

### 5. MITM Center

Start a project HTTP proxy, install its HTTPS inspection CA, and browse live traffic. Filter by method and status, inspect requests and responses, and send selected captures to WebFuzz.

<details>
<summary>View screenshots</summary>

![Actual captured proxy traffic](images/screenshots/mitm.png)

</details>

### 6. WebFuzz request workspace

Edit raw HTTP requests in tabs, select the project, direct, or MITM route, inspect response messages, bodies, and headers, search responses, and revisit history. This capture shows an actual 200 response from a local documentation server.

![Raw request and actual response](images/screenshots/webfuzz.png)

### 7. API modeling

Organize target workflows and endpoints into OpenAPI 3.0 documents. Browse model status, targets, endpoint and entity counts, inspect details, or export the specification.

<details>
<summary>View screenshots</summary>

![Project API models](images/screenshots/api-modeling.png)

</details>

### 8. POC library and feeds

Search and reference Nuclei templates. Manage official or custom feeds, synchronization schedules, and update records under Settings → POC feeds. Synchronizing templates does not execute tests.

<details>
<summary>View screenshots</summary>

![POC search and filters](images/screenshots/pocs.png)

![POC feeds and synchronization](images/screenshots/poc-feeds.png)

</details>

### 9. Open-source intelligence

Add GitHub or GitHub Enterprise repositories and branches in batches and watch commits on interval or Cron schedules. Review security updates, failed judgments, and check errors in one activity view; reproduce, rejudge, ignore, or inspect logs. Reproduction prepares vulnerable and patched source trees and creates an engagement.

<details>
<summary>View screenshots</summary>

![Open-source intelligence onboarding](images/screenshots/code-intel.png)

![Repository monitor configuration](images/screenshots/code-intel-create.png)

</details>

### 10. Android and iOS devices

Connect test devices through DroidBridge or SentinelBridge, manage reverse-connection credentials and device status, and enable shell, files, capture, dynamic debugging, and app analysis per conversation. Android requires root; iOS requires jailbreak. No devices were connected during capture.

<details>
<summary>View screenshots</summary>

![Android device setup](images/screenshots/android.png)

![iOS device setup](images/screenshots/ios.png)

</details>

### 11. Engagements and task orchestration

Paste an authorized target list and choose a doctrine so the commander can organize test tasks. Track status, progress, and submitted results. Engagement mode supports batch work and remains experimental.

<details>
<summary>View screenshots</summary>

![New engagement and target configuration](images/screenshots/engagement-create.png)

</details>

### 12. Approval and audit

Choose manual approval, Auto mode, or AI Approval. Browse AI decisions and automatic-approval logs by project, conversation, source, time, and keyword. Failed or timed-out AI judgments allow execution; see the security boundaries for coverage.

<details>
<summary>View screenshots</summary>

![Approval and tool-call audit](images/screenshots/approvals.png)

</details>

### 13. Execution supervision

Enable a supervision model and intervention policy for a conversation. Review phases, progress, stalls, loops, advice, and token usage to understand why work continues or stops. Configure policies in settings.

<details>
<summary>View screenshots</summary>

![Supervised conversations and execution status](images/screenshots/supervision.png)

</details>

### 14. Models and runtime environment

Manage endpoints in the model library and assign six roles: main, gatekeeper, reviewer, supervisor, commander, and monitor. The environment page checks Docker, images, mounts, and directory access and configures mirrors, networking, and the default proxy.

<details>
<summary>View screenshots</summary>

![Model library](images/screenshots/models.png)

![Six model roles](images/screenshots/model-roles.png)

![Actual Docker checks and network settings](images/screenshots/environment.png)

</details>

### 15. Permissions and agent presets

Control tool permissions and plugin access by agent type. Maintain reusable identities, context, and task instructions for conversations and orchestrated tasks.

<details>
<summary>View screenshots</summary>

![Agent tool permissions](images/screenshots/permissions.png)

![Agent presets](images/screenshots/presets.png)

</details>

### 16. Asset discovery and web search

Configure FOFA, 360 Quake, Qianxin Hunter, and Tavily. Manage credentials, verification, quota, and query records. Tools become available after the required permissions and credential checks pass.

<details>
<summary>View screenshots</summary>

![Asset discovery providers](images/screenshots/asset-discovery.png)

![Tavily keys and search settings](images/screenshots/web-search.png)

</details>

### 17. MCP and plugin center

Connect HTTP, SSE, or stdio MCP servers. Manage local or remote plugin hosts, install official plugins, or upload plugin packages. Plugins can provide their own frontend; the development page includes the specification.

<details>
<summary>View screenshots</summary>

![MCP servers](images/screenshots/mcp.png)

![Official plugin catalog](images/screenshots/official-plugins.png)

</details>

### 18. Team notifications

Connect DingTalk, Feishu, and WeCom bots. Choose events such as run reports, high-severity findings, goal completion, engagement completion, and POC sync failures, and inspect recent delivery results.

<details>
<summary>View screenshots</summary>

![Notification channels and events](images/screenshots/notifications.png)

</details>

### 19. Files and evidence

Open the conversation’s Files panel to upload or preview artifacts and download folders as archives. The agent can use `replay_capture` to preserve a real request/response as a PNG evidence artifact, and `replay_flows` to query its history; evidence capture goes through the approval chain.

<details>
<summary>View screenshots</summary>

![Project file panel](images/screenshots/files.png)

</details>

See the [feature reference](docs/features.en.md), [usage guide](docs/usage.en.md), and [security boundaries](docs/security.en.md) for requirements, workflows, and limitations.

---

<a id="documentation"></a>

## Documentation

| Topic | Guide |
| --- | --- |
| Installation, HTTPS, flags, persistent operation | [Deployment](docs/deployment.en.md) |
| Full capabilities and configuration conditions | [Feature reference](docs/features.en.md) |
| Projects, Web / mini-programs, engagements, approval, POCs | [Usage guide](docs/usage.en.md) |
| HTTP proxy, HTTPS CA, captured traffic | [MITM Center](docs/mitm-center.md) (Chinese) |
| Manual request replay and response inspection | [WebFuzz](docs/webfuzz.md) (Chinese) |
| Android and iOS devices | [Mobile setup](docs/mobile.en.md) |
| Proxy switching, gateways, project migration | [Project gateway](packages/web/docs/project-gateway.md) (Chinese) |
| Asset reporting, linked findings, exports | [Asset library](docs/asset-library.md) (Chinese) |
| Local and remote plugins | [Plugin center](docs/plugin-center.md) (Chinese) |
| Plugin development and frontend | [Authoring](docs/plugin-authoring.md) · [Plugin UI](docs/plugin-ui.md) (Chinese) |
| Repository structure, builds, tests | [Development](docs/development.en.md) |
| Authorization, approval scope, data boundaries | [Security boundaries](docs/security.en.md) |

<a id="license"></a>

## Upstream and license

This project is a derivative work (fork) of [pi](https://github.com/earendil-works/pi). **It is not an official upstream project** and is not affiliated with the upstream team.

The upstream code is released under the MIT License, copyright Mario Zechner. The full license is in [LICENSE](LICENSE). This repository retains that license and copyright notice and adds penetration-testing system prompts, the web console, the containerized workspace, and the Android device plugin.

- Upstream repository: https://github.com/earendil-works/pi
- Copyright for the additions in this repository belongs to the project authors and is also released under MIT.
- Exception: [packages/coding-agent/examples/extensions/doom-overlay/doom/](packages/coding-agent/examples/extensions/doom-overlay/doom/) contains GPLv2 DOOM binaries and corresponding source. It is not MIT-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Star History

<a href="https://www.star-history.com/?repos=zgsfsec%2Ffull-chain-sentinel-system&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=zgsfsec/full-chain-sentinel-system&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=zgsfsec/full-chain-sentinel-system&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=zgsfsec/full-chain-sentinel-system&type=date&legend=top-left" />
 </picture>
</a>
