# Full Chain Sentinel System

**English** | [简体中文](README.md) · **Version 2.2.13**

An authorized penetration-testing agent by Zhigong Shanfang Lab, built on [pi](https://github.com/earendil-works/pi). A bilingual web console brings Web, mini-program, and mobile testing together with project environments, approval, and evidence management.

> **Use only against targets for which you hold written authorization.** Auto mode can run arbitrary commands; operators are responsible for the consequences. Read the [authorized-use statement and security boundaries](docs/security.en.md) before use.

[Community](#community) · [Quick start](#quick-start) · [Capabilities](#capabilities) · [Documentation](#documentation) · [License](#license)

<a id="community"></a>

## Full Chain Sentinel community

Include **"全链哨兵"** in your greeting when joining.

<p>
  <img src="images/Pasted%20image%2020261017125335.png" width="260" alt="Full Chain Sentinel community contact one" />
  <img src="images/Pasted%20image%2020261017125351.png" width="260" alt="Full Chain Sentinel community contact two" />
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

Open the **complete entry URL** printed at startup. Create an account, accept the authorized-use statement, prepare the tool image under Settings → Environment, and configure a Base URL, API key, and model ID under Model settings. Then create a project.

New projects have a work container and a persistent gateway. Switching proxies does not recreate the work container.

### 3. Start testing

Describe your authorized scope and target in the conversation. Approval mode is the default. For mobile testing, connect a device first and enable its tools in the current conversation.

[Deployment and startup flags](docs/deployment.en.md) · [Run from source](docs/deployment.en.md#section-2) · [Usage guide](docs/usage.en.md) · [Device setup](docs/mobile.en.md)

---

<a id="capabilities"></a>

## Capabilities

| Capability | Includes |
| --- | --- |
| Conversations and engagements | Streaming chat, session branches, tool activity, subagents, and batch orchestration |
| Projects and networking | Kali work containers, persistent gateways, SOCKS5/HTTP, subscriptions, WireGuard, OpenVPN, and live exit switching |
| Approval and audit | Manual approval, Auto mode, AI Approval, call logs, and session records |
| Assets and findings | Asset library, vulnerability hub, CVSS, evidence, and Markdown reports |
| Modeling and POCs | OpenAPI modeling and Nuclei POC feeds, search, and references |
| Mobile testing | Android DroidBridge and iOS SentinelBridge, reverse connections, capture, and dynamic analysis |
| Open-source intel | GitHub / GitHub Enterprise branch watch; the Monitor model flags security fixes and hands them to engineering for reproduction |
| Intelligence and plugins | FOFA, Quake, Hunter, Tavily, MCP, and local or remote plugin hosts |
| Replay and evidence | Request replay, history, evidence screenshots, and folder downloads |

See the [feature reference](docs/features.en.md) for configuration requirements and limitations.

<details>
<summary>View a console example</summary>

![Projects and conversations](images/Pasted%20image%2020261017124047.png)

More screenshots are in the [usage guide](docs/usage.en.md). Screenshots illustrate workflows; the current interface may differ.

</details>

---

<a id="documentation"></a>

## Documentation

| Topic | Guide |
| --- | --- |
| Installation, HTTPS, flags, persistent operation | [Deployment](docs/deployment.en.md) |
| Full capabilities and configuration conditions | [Feature reference](docs/features.en.md) |
| Projects, Web / mini-programs, engagements, approval, POCs | [Usage guide](docs/usage.en.md) |
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
