import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** A project id is a UUID; its container is `sentinel-` followed by the first 12 characters of it. */
const PROJECT_ID = "3f2b8c14-9d5e-4a71-b0c6-2e8f5d1a7c93";

/** Every message of one archive job carries the id the server chose for it. */
const ARCHIVE_ID = "9b2e6f10-3c47-4a8d-9e51-7f0c2d8b4a16";

const NOTES_PATH = "/work/evidence/notes.md";
const NOTES_TEXT = "# 登录接口\n\n- 表单地址：https://example.com/login\n- 弱口令：admin / admin，已复现\n";

/** One valid example of each browser-to-server message described in files-terminal.md. */
export const client = {
	list_files: { type: "list_files", path: "/work/evidence" },
	read_file: { type: "read_file", path: NOTES_PATH },
	download_file: { type: "download_file", path: "/work/evidence/login.png" },
	write_file: { type: "write_file", path: NOTES_PATH, text: NOTES_TEXT },
	upload_file: { type: "upload_file", path: "/work/tools/wordlist.txt", data: "YWRtaW46YWRtaW4Kcm9vdDpyb290Cg==" },
	delete_path: { type: "delete_path", path: "/work/evidence/tmp" },
	rename_path: { type: "rename_path", from: NOTES_PATH, to: "/work/evidence/login-notes.md" },
	make_directory: { type: "make_directory", path: "/work/evidence/screenshots" },
	download_folder: { type: "download_folder", path: "/work/evidence" },
	cancel_folder_archive: { type: "cancel_folder_archive", id: ARCHIVE_ID },
	terminal_open: { type: "terminal_open", projectId: PROJECT_ID, cols: 120, rows: 30 },
	terminal_input: { type: "terminal_input", projectId: PROJECT_ID, data: "id\r" },
	terminal_close: { type: "terminal_close", projectId: PROJECT_ID },
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** A 1x1 opaque PNG, 69 bytes. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQyrsBAAIGAWHE0MhtAAAAAElFTkSuQmCC";

/** One valid example of each server-to-browser message described in files-terminal.md. */
export const server = {
	files: {
		type: "files",
		path: "/work/evidence",
		entries: [
			{ name: "screenshots", path: "/work/evidence/screenshots", type: "dir", size: 0, mtime: 1795488000 },
			{ name: "login.png", path: "/work/evidence/login.png", type: "file", size: 69, mtime: 1795488000 },
			{ name: "notes.md", path: NOTES_PATH, type: "file", size: 99, mtime: 1795425160 },
		],
	},
	file_preview: {
		type: "file_preview",
		preview: { path: NOTES_PATH, kind: "text", size: 99, truncated: false, text: NOTES_TEXT },
	},
	file_download: {
		type: "file_download",
		path: "/work/evidence/login.png",
		size: 69,
		data: PNG_BASE64,
		mimeType: "image/png",
	},
	file_result: { type: "file_result", action: "保存", path: NOTES_PATH, ok: true },
	folder_archive_started: {
		type: "folder_archive_started",
		id: ARCHIVE_ID,
		path: "/work/evidence",
		filename: "evidence.tar.gz",
	},
	folder_archive_progress: { type: "folder_archive_progress", id: ARCHIVE_ID, bytes: 1835008 },
	folder_archive_ready: { type: "folder_archive_ready", id: ARCHIVE_ID, filename: "evidence.tar.gz", size: 3762816 },
	folder_archive_failed: {
		type: "folder_archive_failed",
		id: ARCHIVE_ID,
		error: "tar: evidence/lost.txt: Cannot open: No such file or directory\ntar: Exiting with failure status due to previous errors",
	},
	folder_archive_cancelled: { type: "folder_archive_cancelled", id: ARCHIVE_ID },
	terminal_state: {
		type: "terminal_state",
		projectId: PROJECT_ID,
		outcome: "opened",
		session: {
			status: "running",
			projectId: PROJECT_ID,
			projectName: "example-web",
			container: "sentinel-3f2b8c14-9d5e",
			cols: 120,
			rows: 30,
			startedAt: 1795487940000,
			code: null,
		},
		replay: "root@sentinel-3f2b8c14-9d5e:/work# whoami\r\nroot\r\nroot@sentinel-3f2b8c14-9d5e:/work# ",
	},
	terminal_output: {
		type: "terminal_output",
		projectId: PROJECT_ID,
		data: "uid=0(root) gid=0(root) groups=0(root)\r\n",
	},
	terminal_exit: { type: "terminal_exit", projectId: PROJECT_ID, code: 0 },
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
