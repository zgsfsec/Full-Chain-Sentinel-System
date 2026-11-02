/** Copy only a project's public MITM CA into its own work container's system trust store. */
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runDocker } from "./docker.ts";

export function projectMitmDirectory(agentDir: string, id: string): string {
	if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("MITM 项目 ID 无效。");
	const root = join(agentDir, "mitm", id);
	const pointer = join(root, "capture.json");
	if (!existsSync(pointer)) return join(root, "data");
	const name: unknown = JSON.parse(readFileSync(pointer, "utf8"));
	if (typeof name !== "string" || !/^data-[a-f0-9-]{36}$/.test(name)) throw new Error("MITM 数据目录索引损坏。");
	return join(root, name);
}

const INSTALL_CA = `import base64, fcntl, os, pathlib, subprocess, sys, tempfile
certificate = base64.b64decode(sys.argv[1], validate=True)
target = pathlib.Path("/usr/local/share/ca-certificates/sentinel-mitm-center.crt")
bundle = pathlib.Path("/etc/ssl/certs/ca-certificates.crt")
with open("/run/sentinel-mitm-ca.lock", "a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if target.is_file() and not target.is_symlink() and target.read_bytes() == certificate and bundle.is_file() and certificate.strip() in bundle.read_bytes():
        sys.exit(0)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
        temporary.write(certificate)
        temporary_path = temporary.name
    try:
        os.chmod(temporary_path, 0o644)
        os.replace(temporary_path, target)
        subprocess.run(["update-ca-certificates"], check=True, timeout=45)
        subprocess.run(["openssl", "verify", "-CAfile", str(bundle), str(target)], check=True, timeout=5)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)
`;

/** Missing or stopped work containers are left alone; their next start installs the CA. */
export async function installProjectMitmCa(
	agentDir: string,
	project: { id: string; container?: string },
	docker: typeof runDocker = runDocker,
): Promise<void> {
	if (!project.container) return;
	const path = join(projectMitmDirectory(agentDir, project.id), "ca", "ca.crt");
	if (!existsSync(path)) return;
	const certificate = new X509Certificate(readFileSync(path));
	if (!certificate.ca) throw new Error("MITM 中心的证书不是有效的 CA 证书。");
	const state = await docker(["inspect", "--format", "{{.State.Running}}", project.container], { timeoutMs: 15000 });
	if (state.code !== 0) {
		if (/no such (object|container)/i.test(state.stderr)) return;
		throw new Error(`无法检查工作容器证书状态：${state.stderr.trim().slice(-1000)}`);
	}
	if (state.stdout.trim() !== "true") return;
	const result = await docker(
		[
			"exec",
			"--user",
			"0",
			project.container,
			"python3",
			"-c",
			INSTALL_CA,
			Buffer.from(certificate.toString()).toString("base64"),
		],
		{ timeoutMs: 60000 },
	);
	if (result.code !== 0)
		throw new Error(`MITM CA 自动安装失败：${(result.stderr || result.stdout).trim().slice(-1500)}`);
}
