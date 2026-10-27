/**
 * Docker label keys (spec §4.1). The base image carries the `BASE`, `VERSION`,
 * and `PROTOCOL` labels and never a session label; every per-session object
 * carries `SESSION` and `OWNER`.
 */
export const LABEL_BASE = "pi-gui-testing.base";
export const LABEL_VERSION = "pi-gui-testing.version";
export const LABEL_PROTOCOL = "pi-gui-testing.protocol";
export const LABEL_SESSION = "pi-gui-testing.session";
export const LABEL_OWNER = "pi-gui-testing.owner";

/** Value of {@link LABEL_BASE} on the base image. */
export const BASE_LABEL_VALUE = "true";

/** Local tag of the base image; the version label, not the tag, decides freshness. */
export const BASE_IMAGE_REPOSITORY = "pi-gui-testing-base";
