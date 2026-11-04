# Feature reference

[Home](../README.en.md) · [简体中文](features.md)

**Contents**

- [Methodology-driven penetration workflow](#section-1)
- [Bilingual web console](#section-2)
- [Three execution modes](#section-3)
- [Containerized workspace](#section-4)
- [Vulnerability hub](#section-5)
- [Folder download](#section-6)
- [Asset library](#section-7)
- [API modeling and POC library](#section-8)
- [Android device plugin](#section-9)
- [iOS device plugin](#section-10)
- [Asset discovery plugin](#section-11)
- [Web search plugin](#section-12)
- [Custom MCP plugins](#section-13)
- [Community plugin center](#section-14)
- [OpenAI-compatible endpoints](#section-15)
- [Sessions as audit records](#section-16)
- [Project proxies](#section-17)

---

<a id="section-1"></a>

## Methodology-driven penetration workflow

reconnaissance → enumeration → vulnerability mapping → validation → exploitation → post-exploitation → reporting. System prompts emphasize scope, evidence retention, and minimal impact.

<a id="section-2"></a>

## Bilingual web console

 ([packages/web](../packages/web/README.md)): Chinese by default. English can be selected from the sidebar, the sign-in page, and the consent page; server messages, errors, and reports are localized too. Includes streaming chat and reasoning, tool execution cards, a session tree, file and subagent dialogs, and project selection.

<a id="section-3"></a>

## Three execution modes

Approval (default; every bash command can be edited before it is allowed or rejected), Auto, and AI Approval (a Gatekeeper model returns `ALLOW` / `BLOCK` for each command; failures and timeouts fail open). The approval chain covers bash and Android shell commands (`droid_shell`). Frida, packet capture, APK analysis, and the file panel call the container directly and bypass approval.

<a id="section-4"></a>

## Containerized workspace

New projects have a Kali work container and a persistent gateway. Direct access, SOCKS5/HTTP, subscriptions, WireGuard, and OpenVPN share that gateway. Switching the exit updates gateway clients without recreating either container; existing network connections may close. Work-container packages, files, and background processes are retained. See [Project gateway](../packages/web/docs/project-gateway.md) (Chinese).

<a id="section-5"></a>

## Vulnerability hub

`vuln_submit` records validated findings, requires a CVSS score, preserves raw packets verbatim, keeps an operator review timeline, and exports a Markdown report per project.

<a id="section-6"></a>

## Folder download

the file panel's current folder and every folder row have a "Download" action. The container builds a `.tar.gz` with `tar` in the background; WebSocket messages carry progress and cancellation, and the finished archive streams over an authenticated HTTP route. Symlinks are stored as links, hidden files are included, there is no size cap, and the temp archive is deleted after the download or 10 minutes.

<a id="section-7"></a>

## Asset library

the agent reports domains, IPs, IP:port services, and URLs it actually touched with `asset_report` / `asset_note`; the same endpoint merges within a project, and test conclusions accumulate on a timeline. The console filters, changes state and tags, adds records, batch-deletes, and exports Markdown. A finding can link to an asset, and the two details link both ways.

<a id="section-8"></a>

## API modeling and POC library

reconstruct a target site as an OpenAPI 3.0 document; subscribe to, search, and reference Nuclei POCs.

<a id="section-9"></a>

## Android device plugin

install the custom DroidBridge APK on a rooted test device to let it connect back. Provides shell, file upload/download, screenshots, logcat, tcpdump capture, Frida dynamic instrumentation, and APK static analysis.

<a id="section-10"></a>

## iOS device plugin

install the `SentinelBridge` deb on a rootless or rootful jailbroken device; its local control page takes a wss URL and token. Provides shell, file pull/push, app inventory, HTTP logs, packet capture, Frida, decryption, and IPA pull.

<a id="section-11"></a>

## Asset discovery plugin

 (Settings → Asset discovery): integrates **FOFA**, **360 Quake**, and **QiAnXin Hunter**. The agent uses `fofa_search` / `quake_search` / `hunter_search` with each platform's own query syntax to discover public assets (domains, IPs, ports, titles, services, fingerprints). Raw responses are written to the project's `evidence/asset/`, and every query is logged. All three support a **custom base URL** (a reverse-proxy prefix; leave it empty for the official URL). The console appends each platform's API path and re-validates after saving, so a failed validation unmounts the tool. **A platform is mounted only when it is enabled, has a key, and passes validation**; otherwise the agent cannot see that tool at all. Queries are sent directly by the console process; keys never enter the container, bash audit, or Gatekeeper decisions.

<a id="section-12"></a>

## Web search plugin

 (Settings → Web search): integrates **Tavily**. The agent uses `web_search` (public web search) and `web_extract` (page text extraction) for target intelligence such as leaked documents, public reports, and technical articles. Multiple keys form a pool; the console rotates them according to remaining quota and switches when a key is exhausted. Query history is stored in `websearch.db`, and raw responses go to the project's `evidence/search/`. Tools are mounted only when Permissions → Web search is enabled and the pool contains a validated key. Keys are stored in plaintext in the local `websearch.json` (0600) and never enter the container or bash audit.

<a id="section-13"></a>

## Custom MCP plugins

 (Settings → MCP): add, edit, test, and remove MCP servers (`http`, `sse`, or `stdio`) from the console. Tools are exposed as `mcp__<server>__<tool>` and remain subject to the Permissions → MCP master switch, where each server can be enabled or disabled individually. The configuration is owned by Sentinel (`mcp-servers.json`, 0600); **pi's native `mcp.json` is not read**, so servers absent from the list are invisible to the agent. **stdio servers execute directly on the console host** (outside the container and without bash approval), so every one requires an explicit risk acknowledgement before it can be saved.

<a id="section-14"></a>

## Community plugin center

 (Settings → Plugins): plugins are delivered as Docker images and can run locally or on your own VPS. The console connects outbound to plugin hosts, so a local deployment works without a public IP or a reverse tunnel. Each plugin is an MCP server, with tools named `mcp__<plugin>__<tool>` and subject to the Permissions → MCP master switch. Installation displays the network mode and capabilities declared by the manifest; `host` networking and `privileged` require separate confirmation. Tool calls are audited rather than individually blocked, and a plugin can be disabled from the plugin page. A plugin package is a zip containing `plugin.json`, a Dockerfile, and the build context at the root or one directory deep. After upload under Settings → Plugins, the plugin host builds and runs it locally; no image registry is required, and `source` must be public. See [docs/plugin-center.md](plugin-center.md) and [docs/plugin-authoring.md](plugin-authoring.md). A plugin can also ship its own frontend (`ui.entry`): click "Open UI" in the plugin drawer and the console loads `/ui/` from the image in a full-screen iframe with `sandbox="allow-scripts"`. A postMessage bridge lets it call its own tools, read artifacts, and read/write configuration and plugin-scoped storage. The iframe is an opaque origin and cannot read console cookies or the DOM. See [docs/plugin-ui.md](plugin-ui.md).

<a id="section-15"></a>

## OpenAI-compatible endpoints

supports self-hosted endpoints such as vLLM, one-api, and new-api, configured directly in the UI.

<a id="section-16"></a>

## Sessions as audit records

reuses pi's JSONL session tree, retaining commands, output, and model decisions.

<a id="section-17"></a>

## Project proxies

Manage named profiles under Proxies and select a profile or subscription node per project. Subscriptions accept base64 share links, Clash YAML, and sing-box JSON, support scheduled refresh, real URL latency tests, runtime node switching, and automatic node selection. SOCKS5/HTTP, WireGuard, and OpenVPN profiles also support connectivity tests. Credentials are mounted only in the gateway. OpenVPN supports inline certificates, separate credentials, and pushed DNS; sharing tunnel credentials between tests and running projects can interrupt connections. See [Project gateway](../packages/web/docs/project-gateway.md) (Chinese).

<a id="section-19"></a>

## Open-source vulnerability watch

(Project → Intelligence → Open-source intel.) Enter GitHub or GitHub Enterprise repository addresses, one per line to add several at once. Each repository watches `main` by default, and branches can be changed individually after loading them. The console records each branch's current HEAD as the baseline before polling the GitHub REST API for new commits.

- **Check strategy**: each monitor can run on a fixed interval (10 minutes to 24 hours, or manual only) or a five-field cron expression (minute hour day month weekday, in the server's local time zone) with a preview of the next three firings. Select several rows and use Batch strategy to change them at once. The cron editor offers common presets and a per-field checkbox table (minute / hour / day / month / weekday), while the expression itself stays editable.
- **Project activity**: the Open-source Intelligence page has an Activity tab scoped to the current project. It aggregates ready-to-reproduce findings, failed judgments, failed dispatches, in-flight judgments and check errors, with filtering, pagination and batch reproduce/rejudge/ignore. Auto-dispatched successes stay out of the default inbox but remain available under All.
- **Select all across pages**: after pagination, Select all in the toolbar selects every monitor in the current project, not only the visible page; batch schedule, batch check and batch delete then apply to all of them.
- **Batch delete**: select several monitors and delete them together. Commits, check logs, queued jobs and the host-side token are removed; projects are unaffected.
- **Batch checks**: select several repositories in the list and use Check selected to poll all of them at once; each row still has its own Check button.
- **Check queue**: requests enter a persistent queue with at most three concurrent checks globally and two per GitHub host. Failures retry after 30 seconds, 2 minutes and 5 minutes, up to three attempts. Queued jobs survive a restart; running jobs are requeued.
- **Bulk import queue**: the server creates pasted repositories one at a time with a 1.2s gap, shows progress and aggregates failures instead of firing hundreds of requests at once. Branch probes are also serialized (500ms apart), keeping the page responsive and avoiding 429s. The queue runs on the server, so a browser refresh keeps importing and shows the progress again. A missing `main` falls back to the repository's real default branch.
- **Pagination**: the monitor list, commit list and import repository list render in pages, so hundreds of rows do not freeze the page.
- **GitHub rate-limit protection**: REST calls are serialized per host with a gap (500 ms with a token, 1.5 s without). A 429/abuse response is honoured via `Retry-After`, and the whole host cools down for at least five minutes before queued jobs resume. Without a token a pass consumes at most five commits, reducing bursts. Configure a token for the 5000/hour quota.
- **Check log**: every run records its trigger (manual / scheduled / batch), result, duration, commits consumed, security findings and error text. A check interrupted by a service restart is marked failed, so the history stays auditable. The detail page's Queue tab shows queued, running, retrying and finished jobs.
- **Verdict**: each commit's message, changed files and diff go to the Monitor model (Settings → Models). Dependency-only bumps, merge commits and empty diffs are skipped; an oversized diff keeps the file list and as much of the patch as fits.
- **Findings**: security fixes land in the list, deduplicate by CVE/GHSA or patch title, and can be pushed to DingTalk, Feishu or WeCom. Each finding waits for confirmation unless auto-dispatch is enabled on the monitor.
- **Reproduction**: confirming first prepares the source in the project container under the console's control: the token reaches git over stdin, never on disk, in the clone URL or in the model context, and the helper script is removed once checkout finishes. Then one engineering run is created per finding with the vulnerable parent and the fixed commit checked out. The run follows the "open-source 1day reproduction" doctrine: write a PoC/exp, trigger it on the vulnerable tree, and prove it no longer triggers on the fixed tree. A failed build (missing dependency, special environment) fails the task; it is never reported as a success.
- **Token**: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token; choose the repository under Repository access and set Repository permissions → Contents to Read-only (Metadata is read-only automatically), then copy the `github_pat_` token. GitHub Enterprise uses the same path with the instance host; a classic token with `repo` scope also works.
- **Limits**: GitHub-family APIs only (github.com and GitHub Enterprise, with an optional API base). GitLab and Gitea are not supported yet. SSH addresses are parsed for the repository, but cloning still uses HTTPS, so private repositories need a token with Contents read access. Tokens stay on the console host in `code-monitor-secrets.json` (0600).
