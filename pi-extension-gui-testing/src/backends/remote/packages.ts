/**
 * Remote package names per package manager for the remediation commands of
 * the remote checks (spec §5.4 "remote package install"). Setup never runs
 * them without confirmation or `--fix`, and only through `sudo -n` (it never
 * handles a sudo password).
 */
import { shellJoin } from "../../transport/ssh/quote.ts";

export type PackageManager = "apt-get" | "pacman" | "dnf" | "zypper" | "apk";

export const PACKAGE_MANAGERS: readonly PackageManager[] = ["pacman", "apt-get", "dnf", "zypper", "apk"];

/** Logical tools and their packages. */
export const PACKAGES: Record<string, Record<PackageManager, string[]>> = {
  xvfb: { "apt-get": ["xvfb"], pacman: ["xorg-server-xvfb"], dnf: ["xorg-x11-server-Xvfb"], zypper: ["xorg-x11-server-Xvfb"], apk: ["xvfb"] },
  xdotool: { "apt-get": ["xdotool"], pacman: ["xdotool"], dnf: ["xdotool"], zypper: ["xdotool"], apk: ["xdotool"] },
  screenshot: { "apt-get": ["imagemagick"], pacman: ["imagemagick"], dnf: ["ImageMagick"], zypper: ["ImageMagick"], apk: ["imagemagick"] },
  dbus: { "apt-get": ["dbus"], pacman: ["dbus"], dnf: ["dbus-daemon"], zypper: ["dbus-1"], apk: ["dbus"] },
  atspi: { "apt-get": ["at-spi2-core"], pacman: ["at-spi2-core"], dnf: ["at-spi2-core"], zypper: ["at-spi2-core"], apk: ["at-spi2-core"] },
  pyatspi: { "apt-get": ["python3-pyatspi"], pacman: ["python-atspi"], dnf: ["python3-pyatspi"], zypper: ["python3-pyatspi"], apk: ["py3-atspi"] },
  wm: { "apt-get": ["openbox"], pacman: ["openbox"], dnf: ["openbox"], zypper: ["openbox"], apk: ["openbox"] },
  fonts: { "apt-get": ["fonts-dejavu-core"], pacman: ["ttf-dejavu"], dnf: ["dejavu-sans-fonts"], zypper: ["dejavu-fonts"], apk: ["font-dejavu"] },
  python: { "apt-get": ["python3"], pacman: ["python"], dnf: ["python3"], zypper: ["python3"], apk: ["python3"] },
  gtk: { "apt-get": ["python3-gi", "gir1.2-gtk-3.0"], pacman: ["python-gobject", "gtk3"], dnf: ["python3-gobject", "gtk3"], zypper: ["python3-gobject", "typelib-1_0-Gtk-3_0"], apk: ["py3-gobject3", "gtk+3.0"] },
  rsync: { "apt-get": ["rsync"], pacman: ["rsync"], dnf: ["rsync"], zypper: ["rsync"], apk: ["rsync"] },
  coreutils: { "apt-get": ["coreutils", "tar"], pacman: ["coreutils", "tar"], dnf: ["coreutils", "tar"], zypper: ["coreutils", "tar"], apk: ["coreutils", "tar"] },
};

/** Install argv for `pm` (non-interactive). */
export function installArgv(pm: PackageManager, packages: readonly string[]): string[] {
  switch (pm) {
    case "apt-get":
      return ["apt-get", "install", "-y", ...packages];
    case "pacman":
      return ["pacman", "-S", "--needed", "--noconfirm", ...packages];
    case "dnf":
      return ["dnf", "install", "-y", ...packages];
    case "zypper":
      return ["zypper", "--non-interactive", "install", ...packages];
    case "apk":
      return ["apk", "add", ...packages];
  }
}

export function isPackageManager(value: string | undefined): value is PackageManager {
  return value !== undefined && (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/** The local argv that installs `packages` on `destination` with `sudo -n` (fails instead of asking for a password). */
export function remoteInstallCommand(destination: string, pm: PackageManager, packages: readonly string[], ssh = "ssh"): string[] {
  return [ssh, "-o", "BatchMode=yes", "-T", "--", destination, shellJoin(["sudo", "-n", ...installArgv(pm, packages)])];
}

/** The command a user runs themselves (password prompt allowed): `ssh -t <host> sudo …`. */
export function manualInstallCommand(destination: string, pm: PackageManager | undefined, packages: readonly string[]): string {
  if (!pm) return `install on ${destination}: ${packages.join(" ")}`;
  return `ssh -t ${destination} ${shellJoin(["sudo", ...installArgv(pm, packages)])}`;
}
