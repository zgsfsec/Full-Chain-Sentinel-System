# Full Chain Sentinel pentest toolbox image.
# Build: docker build -t sentinel:latest docker/
#
# Base image and package sources are configurable, so the build can run behind a
# Chinese mirror or an internal registry. The console sets these from
# 设置 → 环境 → 构建源; the same values work on the command line:
#
#   docker build -t sentinel:latest \
#     --build-arg BASE_IMAGE=docker.m.daocloud.io/kalilinux/kali-rolling:latest \
#     --build-arg APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/kali \
#     --build-arg PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     --build-arg GO_PROXY=https://goproxy.cn,direct \
#     docker/
#
# Base is Kali rolling; pinned tool groups are installed with apt. The
# "extended" layer installs packages whose availability varies across Kali
# releases and is allowed to fail without breaking the build.

ARG BASE_IMAGE=kalilinux/kali-rolling:latest
FROM ${BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=
ARG PIP_INDEX=
ARG NPM_REGISTRY=
ARG GO_PROXY=
# Container runtime may inject a host proxy that apt cannot use (socks5); clear it.
ENV http_proxy= https_proxy= all_proxy= HTTP_PROXY= HTTPS_PROXY= ALL_PROXY=

# ca-certificates first: an https mirror cannot be fetched before it exists. This
# is the only step that has to reach the original source; when it is unreachable
# the build continues and only https mirrors are affected (http mirrors, which is
# what the official Kali sources use, keep working).
RUN (apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*) \
	|| echo "[sentinel] ca-certificates preinstall skipped (original source unreachable)"

# Point apt at the configured mirror. Kali rolling ships deb822 sources in
# /etc/apt/sources.list.d/kali.sources with URIs on http.kali.org or kali.download;
# older images use /etc/apt/sources.list. Both spellings are rewritten, and apt
# still verifies package signatures through the archive keyring.
RUN if [ -n "$APT_MIRROR" ]; then \
		for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do \
			[ -f "$f" ] || continue; \
			sed -i "s|http://http.kali.org/kali|$APT_MIRROR|g; s|https://http.kali.org/kali|$APT_MIRROR|g; s|http://kali.download/kali|$APT_MIRROR|g; s|https://kali.download/kali|$APT_MIRROR|g" "$f"; \
		done; \
		echo "[sentinel] apt mirror: $APT_MIRROR"; \
	fi

# Core toolchain: recon/enumeration, web exploitation, brute force / intranet.
RUN apt-get update && apt-get install -y --no-install-recommends \
		# WireGuard: the console runs a project's WireGuard sidecar from this same
		# image, because a real interface is what makes ping and UDP go through the
		# tunnel (a proxy engine cannot carry ICMP). wg-quick needs iproute2.
		wireguard-tools \
		iproute2 \
		# OpenVPN: the same argument, for a userspace client instead of a kernel
		# module — the sidecar's main process is the tunnel, and iproute2 is what its
		# kill switch uses. iputils-ping is here because "ping goes through the
		# tunnel" is the whole point of a tunnel profile and has to be checkable from
		# inside the job container.
		openvpn \
		iputils-ping \
		iptables \
		# recon & enumeration
		nmap \
		masscan \
		dnsrecon \
		whatweb \
		subfinder \
		enum4linux \
		# web exploitation
		ffuf \
		dirsearch \
		wafw00f \
		testssl.sh \
		sqlmap \
		# brute force / intranet movement. hashcat is deliberately absent: the
		# container gets no GPU (docker run passes no --gpus/--device), so it would
		# crack through PoCL on the CPU and lose to john, while pulling ~400 MB of
		# OpenCL/LLVM/clang dependencies. john covers CPU cracking.
		john \
		hydra \
		netexec \
		impacket-scripts \
		# fundamentals
		curl \
		wget \
		whois \
		netcat-traditional \
		socat \
		openssh-client \
		proxychains4 \
		git \
		jq \
		python3 \
		python3-pip \
		ripgrep \
		fd-find \
		zip \
		unzip \
		libplist-utils \
	&& rm -rf /var/lib/apt/lists/*

# Extended tools: availability varies by Kali release; failures are tolerated.
RUN apt-get update && apt-get install -y --no-install-recommends \
		responder \
		chisel \
	|| echo "[sentinel] extended tools partially unavailable (ok)" \
	&& rm -rf /var/lib/apt/lists/*

# Package sources for installs made inside the running container: pip reads
# /etc/pip.conf, npm reads /root/.npmrc, and go reads /root/.config/go/env
# without needing a login shell (docker exec starts a plain sh).
RUN if [ -n "$PIP_INDEX" ]; then \
		host=$(echo "$PIP_INDEX" | sed -E 's|^https?://([^/:]+).*|\1|'); \
		printf '[global]\nindex-url = %s\ntrusted-host = %s\n' "$PIP_INDEX" "$host" > /etc/pip.conf; \
		echo "[sentinel] pip index: $PIP_INDEX"; \
	fi; \
	if [ -n "$NPM_REGISTRY" ]; then \
		mkdir -p /usr/etc; \
		printf 'registry=%s\n' "$NPM_REGISTRY" > /root/.npmrc; \
		printf 'registry=%s\n' "$NPM_REGISTRY" > /usr/etc/npmrc; \
		echo "[sentinel] npm registry: $NPM_REGISTRY"; \
	fi; \
	if [ -n "$GO_PROXY" ]; then \
		mkdir -p /root/.config/go; \
		printf 'GOPROXY=%s\n' "$GO_PROXY" > /root/.config/go/env; \
		echo "[sentinel] go proxy: $GO_PROXY"; \
	fi

WORKDIR /work

# Android analysis layer (Droid 插件): decompile (jadx/apktool both pull in a JRE),
# capture parsing (tshark) and dynamic instrumentation (frida-tools via pip).
# jadx/apktool/tshark are reliable Kali packages; frida-tools is best-effort so a
# pip hiccup cannot fail the whole image build.
RUN apt-get update && apt-get install -y --no-install-recommends \
		jadx \
		apktool \
		tshark \
	&& rm -rf /var/lib/apt/lists/* \
	&& (pip3 install --break-system-packages frida-tools 2>/dev/null \
		|| pip3 install frida-tools 2>/dev/null \
		|| echo "[sentinel] frida-tools install skipped (ok)")

# Packet replay and headless render (设置 → 发包, the replayd service). The binary
# itself is pushed into the container by the console at first use — version-locked
# to the console — but the browser it drives has to be in the image: replayd never
# downloads one on its own ("未找到可用浏览器"), and a pentest host is often offline.
# fonts-noto-cjk keeps Chinese pages readable in the screenshots instead of tofu.
# Best effort, like the extended layer above: a mirror without these packages must
# not fail the whole build, and the console reports the missing browser with the
# command to install it.
RUN apt-get update && apt-get install -y --no-install-recommends \
		chromium \
		fonts-noto-cjk \
	|| echo "[sentinel] chromium/fonts 安装跳过（发包截图需要浏览器，可稍后在容器内补装或重建镜像）" \
	&& rm -rf /var/lib/apt/lists/*

# Credential clients: reuse SSH, curl, NetExec and Impacket from the core layer.
# Install clients only, without recommended packages, database servers, desktop
# runtimes or the much larger mongosh bundle. PyMongo provides MongoDB auth/ping;
# dnspython supports mongodb+srv addresses.
RUN apt-get update && apt-get install -y --no-install-recommends \
		sshpass \
		ldap-utils \
		mariadb-client-core \
		postgresql-client \
		redis-tools \
		sqlite3 \
		freetds-bin \
		snmp \
		python3-pymongo \
		python3-dnspython \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

# Intranet clients: reuse NetExec, Impacket, SSH and LDAP already installed above.
# Keep this layer last to preserve the existing toolbox cache. These Kali packages
# support amd64/arm64; no BloodHound UI, graph database or recommended packages.
RUN apt-get update && apt-get install -y --no-install-recommends \
		krb5-user \
		smbclient \
		evil-winrm \
		bloodhound.py \
		nfs-common \
		rsync \
	&& for tool in kinit klist smbclient rpcclient evil-winrm bloodhound-python showmount nfsstat rpcinfo rsync; do \
		command -v "$tool" >/dev/null || exit 1; \
	done \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

# Long-running idle entrypoint; Full Chain Sentinel drives it with docker exec.
CMD ["sleep", "infinity"]
