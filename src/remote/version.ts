// Keep the Pi release separate from the Codex App Server compatibility baseline.
// Desktop checks the first product/version token during initialize (minimum
// 0.141.0 observed on 2026-10-01). This is a partial adapter, not a Codex binary:
// supported responses are schema-tested; unsupported methods must still fail.
export const APP_SERVER_VERSION = "0.141.0";
export const PACKAGE_VERSION = "0.1.0";
export const APP_SERVER_USER_AGENT = `pi-codex-ish/${APP_SERVER_VERSION} (pi-codex-ish ${PACKAGE_VERSION})`;
