/**
 * Public project identity used by the console UI.
 *
 * Keep the repository and license URLs here so the about page, login screen,
 * sidebar, and consent gate cannot drift apart. The version is injected by Vite
 * from `packages/web/package.json` at build time (see `vite.config.ts`).
 */

import { t } from "./i18n.ts";

export const PROJECT_NAME = t("全链哨兵");
export const PROJECT_REPOSITORY = "https://github.com/zgsfsec/Full-Chain-Sentinel-System";
export const PROJECT_RELEASES_URL = `${PROJECT_REPOSITORY}/releases/latest`;
export const PROJECT_LATEST_RELEASE_API = `${PROJECT_REPOSITORY.replace("https://github.com/", "https://api.github.com/repos/")}/releases/latest`;
export const PROJECT_LICENSE = "MIT";
export const PROJECT_LICENSE_URL = `${PROJECT_REPOSITORY}/blob/main/LICENSE`;

/** Web console version, replaced by Vite at build time. */
export const CONSOLE_VERSION = __SENTINEL_VERSION__;
