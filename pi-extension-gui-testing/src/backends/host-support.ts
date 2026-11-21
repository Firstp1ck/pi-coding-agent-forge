/**
 * Which client operating systems can run each backend (spec §4 table). A leaf
 * module: the `host.os` check and the backend registry both read it.
 */

export interface HostSupport {
  /** Client platforms (`process.platform`) the backend runs on in this build. */
  platforms: readonly NodeJS.Platform[];
  /** Shown by `host.os` on any other platform. */
  otherwise: string;
}

export const DOCKER_LINUX_HOST_SUPPORT: HostSupport = {
  // Linux with Docker Engine; macOS and Windows with Docker Desktop's Linux containers (M1c).
  platforms: ["linux", "darwin", "win32"],
  otherwise: "docker-linux runs on Linux (Docker Engine), macOS, and Windows (Docker Desktop with Linux containers)",
};
