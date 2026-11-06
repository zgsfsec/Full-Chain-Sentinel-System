/**
 * A `docker` stand-in for the console tests.
 *
 * The console refuses to run anything outside a project container, so tests need
 * a container backend. Rather than letting production code fall back to host
 * execution, the tests put a fake `docker` first on PATH: the subcommands the
 * console issues succeed, and `exec` runs the command on the host after
 * rewriting `/work` to the project work directory. That keeps the real code path
 * (including the container scripts in files.ts) under test without Docker.
 *
 * Container lifecycle is tracked per name, because stopping, starting and
 * removing containers is behaviour under test: `docker ps -a` reports what the
 * fake knows, while a container it never saw still counts as running, so tests
 * that never create one keep their previous meaning.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `#!/bin/sh
# Test stand-in for docker. Only the subcommands the console issues are handled.
# With SENTINEL_FAKE_DOCKER_LOG set, every invocation is appended, so a test can assert
# what the console asked for (e.g. the flags a container was created with).
[ -n "\${SENTINEL_FAKE_DOCKER_LOG:-}" ] && printf '%s\\n' "$*" >> "$SENTINEL_FAKE_DOCKER_LOG"
state_dir="\${SENTINEL_FAKE_DOCKER_STATE:-}"
# What run/start recorded beyond the state itself: the network a container was
# created on and when it last started. Kept in a dot directory so \`ps\` (which
# globs the state directory) never mistakes them for containers.
meta="$state_dir/.meta"

# Record a container's state: running, stopped, or removed.
mark() {
	[ -n "$state_dir" ] || return 0
	mkdir -p "$state_dir"
	printf '%s' "$1" > "$state_dir/$2"
	# Docker reports the last start time, so it only moves when it starts.
	if [ "$1" = "running" ]; then
		mkdir -p "$meta"
		date -u +%Y-%m-%dT%H:%M:%SZ > "$meta/$2.started"
	fi
	return 0
}

# The container name is the last argument of start/stop/rm/inspect.
last_arg() {
	_last=""
	for _arg in "$@"; do _last="$_arg"; done
	printf '%s' "$_last"
}

cmd="$1"
shift
case "$cmd" in
	create) printf 'fake-donor\\n'; exit 0 ;;
	cp)
		case "$1" in *:/usr/local/bin/sing-box) printf '#!/bin/sh\\nexit 0\\n' > "$2"; chmod +x "$2" ;; esac
		exit 0 ;;
	pause|unpause) exit 0 ;;
	image|build) exit 0 ;;
	run)
		# The disposable environment probe never administers the host network.
		case "$*" in *"sentinel-gateway probe") printf 'gateway-ready: 4 6\\n'; exit 0 ;; esac
		# docker run -d --name <name> --network <mode> ...: remember the new container
		# as running, with the network it was created on. A container's network mode
		# is fixed at creation, which is exactly what the console inspects for.
		name=""
		network=""
		prev=""
		gateway_dir=""
		resolver=""
		for arg in "$@"; do
			[ "$prev" = "--name" ] && name="$arg"
			[ "$prev" = "--network" ] && network="$arg"
			case "$arg" in *:/etc/sentinel-gateway:ro) gateway_dir="\${arg%:/etc/sentinel-gateway:ro}" ;; esac
			case "$arg" in *:/etc/resolv.conf) resolver="\${arg%:/etc/resolv.conf}" ;; esac
			prev="$arg"
		done
		if [ -n "$name" ]; then
			mark running "$name"
			if [ -n "$gateway_dir" ]; then
				printf '%s' "$gateway_dir" > "$meta/$name.gateway"
				printf '%s' "$resolver" > "$meta/$name.resolver"
				rm -f "$meta/$name.hash"
			fi
			if [ -n "$network" ]; then
				mkdir -p "$meta"
				printf '%s' "$network" > "$meta/$name.network"
			fi
		fi
		exit 0
		;;
	start) mark running "$(last_arg "$@")"; exit 0 ;;
	stop) mark stopped "$(last_arg "$@")"; exit 0 ;;
	rm) mark removed "$(last_arg "$@")"; exit 0 ;;
	inspect)
		target="$(last_arg "$@")"
		state=""
		[ -n "$state_dir" ] && [ -f "$state_dir/$target" ] && state=$(cat "$state_dir/$target")
		case "$target:$state" in *-sb-*: ) echo "no such gateway" >&2; exit 1 ;; esac
		format=""
		for arg in "$@"; do
			case "$arg" in *"{{"*) format="$arg" ;; esac
		done
		# The fields the console asks about that Docker answers from its own record
		# rather than from the container's run state. Like Docker, they are only
		# answered for a container that exists.
		case "$format" in
			*NetworkMode*|*StartedAt*|*".Id"*)
				case "$state" in
					""|removed) echo "Error: No such container: $target" >&2; exit 1 ;;
				esac
				;;
		esac
		case "$format" in
			*NetworkMode*)
				network="default"
				[ -f "$meta/$target.network" ] && network=$(cat "$meta/$target.network")
				case "$format" in
					*"State.Status"*)
						case "$state" in
							stopped) printf 'exited %s\\n' "$network" ;;
							removed|"") printf ' %s\\n' "$network" ;;
							*) printf 'running %s\\n' "$network" ;;
						esac
						;;
					*) printf '%s\\n' "$network" ;;
				esac
				exit 0
				;;
			*StartedAt*)
				if [ -f "$meta/$target.started" ]; then
					cat "$meta/$target.started"
					printf '\\n'
				else
					printf '0001-01-01T00:00:00Z\\n'
				fi
				exit 0
				;;
			*".Id"*)
				# The name stands in for the id: inspect of the owner and the network
				# mode of the container that joined it then agree, the way Docker's
				# full ids do.
				printf '%s\\n' "$target"
				exit 0
				;;
		esac
		case "$state" in
			running)
				case "$format" in *State.Paused*) echo "true false" ;; *) echo "true" ;; esac
				exit 0 ;;
			stopped) echo "false"; exit 0 ;;
			removed) echo "Error: No such container: $target" >&2; exit 1 ;;
			*) echo "true"; exit 0 ;;
		esac
		;;
	ps)
		[ -n "$state_dir" ] || exit 0
		[ -d "$state_dir" ] || exit 0
		for file in "$state_dir"/*; do
			[ -f "$file" ] || continue
			name=$(basename "$file")
			state=$(cat "$file")
			case "$state" in
				running) printf '%s\\t%s\\n' "$name" running ;;
				stopped) printf '%s\\t%s\\n' "$name" exited ;;
			esac
		done
		exit 0
		;;
	exec)
		# Gateway scripts contain network administration: never execute them on the
		# test host. Model their applied hash separately from container lifecycle.
		case "$*" in
			*/etc/sentinel-gateway/*|*/run/sentinel-gateway/*)
				[ "$1" = "-i" ] && shift
				gateway="$1"
				directory=""
				[ -f "$meta/$gateway.gateway" ] && directory=$(cat "$meta/$gateway.gateway")
				case "$*" in
					*"runtime.sh status"*) [ -f "$meta/$gateway.hash" ] && cat "$meta/$gateway.hash"; exit 0 ;;
					*"runtime.sh apply"*)
						if [ -f "$meta/$gateway.reject" ]; then cat "$meta/$gateway.reject" >&2; exit 1; fi
						[ -n "$directory" ] && cp "$directory/candidate/hash" "$meta/$gateway.hash"
						if [ -f "$meta/$gateway.resolver" ]; then cp "$directory/candidate/resolv.conf" "$(cat "$meta/$gateway.resolver")"; fi
						exit 0 ;;
				esac
				exit 0 ;;
		esac
		# The profile test fetches a URL from inside a tunnel container with curl;
		# answer like a healthy exit so the probe's own bookkeeping is what is tested.
		if [ "$2" = "curl" ]; then
			printf '204 0.123\\n'
			exit 0
		fi
		# The console asks a tunnel sidecar for its interfaces (ip -o addr show),
		# because a container that shares the namespace has to be checked for a tunnel
		# rather than asked about one. The host has no ip command, so the fake answers
		# the way a connected sidecar does.
		if [ "$1" != "-i" ] && [ "$2" = "ip" ]; then
			printf '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\\n'
			printf '2: tun0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1400\\n'
			exit 0
		fi
		[ "$1" = "-i" ] && shift
		# dockerBashOperations passes the session cwd as the exec working dir.
		[ "$1" = "-w" ] && shift 2
		shift
		# Remaining arguments: sh -c <script> zg <args...>
		shift 2
		script="$1"; shift
		[ "$1" = "zg" ] && shift
		root="\${SENTINEL_FAKE_WORKDIR:-/work}"
		script=$(printf '%s' "$script" | sed "s#/work#\${root}#g")
		# Tooling the console keeps outside the work directory (the replayd binary
		# lives in /opt/sentinel) is redirected too, so scripts that inspect or write
		# it can be tested without touching the host's /opt.
		sentinel="\${SENTINEL_FAKE_SENTINEL_DIR:-/opt/sentinel}"
		script=$(printf '%s' "$script" | sed "s#/opt/sentinel#\${sentinel}#g")
		# A proxied container has host.docker.internal appended to /etc/hosts; on the
		# host that is a real system file, so the path is redirected as well.
		hosts="\${SENTINEL_FAKE_HOSTS:-/etc/hosts}"
		script=$(printf '%s' "$script" | sed "s#/etc/hosts#\${hosts}#g")
		# Rotate the positional parameters, rewriting each one.
		count=$#
		i=0
		while [ "$i" -lt "$count" ]; do
			arg="$1"; shift
			arg=$(printf '%s' "$arg" | sed "s#/work#\${root}#g")
			set -- "$@" "$arg"
			i=$((i + 1))
		done
		exec sh -c "$script" zg "$@"
		;;
	*) exit 0 ;;
esac
`;

export interface FakeDocker {
	/** Directory holding the fake executable. */
	dir: string;
	/** Where the fake records container lifecycle, for tests that need to seed it. */
	stateDir: string;
	/** Restores PATH and the environment variables this helper set. */
	restore(): void;
}

/**
 * Install the fake docker under `root` and point the project layout at `root`:
 * `SENTINEL_PROJECTS_DIR` keeps project creation out of the operator's home,
 * `SENTINEL_FAKE_WORKDIR` is what the fake rewrites `/work` to, and
 * `SENTINEL_FAKE_SENTINEL_DIR` does the same for `/opt/sentinel` (where the
 * container-side tooling lives) and `SENTINEL_FAKE_HOSTS` for `/etc/hosts` (which a
 * proxied container appends `host.docker.internal` to). Passing `logPath` records
 * every invocation there, one command line per call.
 */
export function installFakeDocker(root: string, workDir: string, logPath?: string): FakeDocker {
	const dir = join(root, "fake-docker");
	mkdirSync(dir, { recursive: true });
	const binary = join(dir, "docker");
	writeFileSync(binary, SCRIPT);
	chmodSync(binary, 0o755);

	const previousPath = process.env.PATH;
	const previousProjectsDir = process.env.SENTINEL_PROJECTS_DIR;
	const previousWorkDir = process.env.SENTINEL_FAKE_WORKDIR;
	const previousLog = process.env.SENTINEL_FAKE_DOCKER_LOG;
	const previousState = process.env.SENTINEL_FAKE_DOCKER_STATE;
	const previousSentinel = process.env.SENTINEL_FAKE_SENTINEL_DIR;
	const previousHosts = process.env.SENTINEL_FAKE_HOSTS;
	process.env.PATH = `${dir}:${previousPath ?? ""}`;
	process.env.SENTINEL_PROJECTS_DIR = join(root, "projects");
	process.env.SENTINEL_FAKE_WORKDIR = workDir;
	process.env.SENTINEL_FAKE_DOCKER_STATE = join(root, "fake-docker-state");
	process.env.SENTINEL_FAKE_SENTINEL_DIR = join(root, "fake-opt-sentinel");
	process.env.SENTINEL_FAKE_HOSTS = join(root, "fake-etc-hosts");
	if (logPath) process.env.SENTINEL_FAKE_DOCKER_LOG = logPath;

	return {
		dir,
		stateDir: process.env.SENTINEL_FAKE_DOCKER_STATE,
		restore() {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousProjectsDir === undefined) delete process.env.SENTINEL_PROJECTS_DIR;
			else process.env.SENTINEL_PROJECTS_DIR = previousProjectsDir;
			if (previousWorkDir === undefined) delete process.env.SENTINEL_FAKE_WORKDIR;
			else process.env.SENTINEL_FAKE_WORKDIR = previousWorkDir;
			if (previousLog === undefined) delete process.env.SENTINEL_FAKE_DOCKER_LOG;
			else process.env.SENTINEL_FAKE_DOCKER_LOG = previousLog;
			if (previousState === undefined) delete process.env.SENTINEL_FAKE_DOCKER_STATE;
			else process.env.SENTINEL_FAKE_DOCKER_STATE = previousState;
			if (previousSentinel === undefined) delete process.env.SENTINEL_FAKE_SENTINEL_DIR;
			else process.env.SENTINEL_FAKE_SENTINEL_DIR = previousSentinel;
			if (previousHosts === undefined) delete process.env.SENTINEL_FAKE_HOSTS;
			else process.env.SENTINEL_FAKE_HOSTS = previousHosts;
		},
	};
}

/** Slug rule mirrored from docker.ts, for predicting a project's work directory. */
export function projectSlug(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
			.slice(0, 40) || "project"
	);
}
