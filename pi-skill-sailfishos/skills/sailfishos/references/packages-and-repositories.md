# Packages, repositories, and OS upgrades

## Tools and layers

Sailfish is RPM-based. `rpm` tracks installed files/dependencies; `pkcon` is the PackageKit client; SSU manages repositories/access according to release, hardware, region/licence, and personal repos. libzypp repository files are under /etc/zypp, but Sailfish is **not a stock openSUSE/Fedora installation**. [D03, D04]

- **Device**: prefer pkcon. Queries often work as normal user; mutation authorization depends on root/Polkit/session policy.
- **SDK target**: zypper is common; target changes affect that build root, not the phone. [D10, D11]
- `zypper` may be installable but must not be assumed present or installed unnecessarily.
- Do not assume apt/dpkg, pacman, dnf, or personal convenience wrappers exist.

## Query before changing anything (normal user)

Replace PACKAGE/SEARCH/FILE.rpm with actual values; quote variables.
```sh
command -v pkcon
command -v rpm
command -v ssu
ssu lr
LC_ALL=C pkcon --plain search name SEARCH
LC_ALL=C pkcon --plain --filter '~source' resolve PACKAGE
rpm -q PACKAGE
rpm -qi PACKAGE
rpm -ql PACKAGE
rpm -qf /absolute/path/to/file
rpm -qR PACKAGE
rpm -q --whatrequires PACKAGE
rpm -qp --scripts FILE.rpm
rpm -qpR FILE.rpm
rpm -K FILE.rpm
```

Reverse RPM dependency queries are hints, not a complete transaction-impact simulation. Have the package manager compute the transaction. A “digests OK” result only confirms internal checksums: **it does not authenticate a publisher** if no signature was verified.

### Package availability helper

```sh
/bin/sh <skill-directory>/scripts/package-available.sh PACKAGE [PACKAGE ...]
```
- Exit 0: every name yielded an installed or available non-source result.
- Exit 2: usage/invalid name.
- Exit 3: at least one name had no match; no install was attempted.
- Exit 1: environment/tool/query failure; don't misreport as an unavailable package.

This does not refresh repositories, install, or elevate. Cached results may be stale. Run an authorized refresh when freshness is required. Use LC_ALL=C because Installed/Available output is localized otherwise. The correct inverted filter is `'~source'`, **not `not-source`**, on this PackageKit version. `pkcon --plain get-filters` lists supported base filters. A zero return from resolve with an empty Results section is possible.

## Install/remove workflow (root, authorized, interactive)

1. Verify requested package names, current repositories, storage and connectivity.
2. Check no OS update or other transaction is in progress. Let PackageKit queue normally; don't kill a transaction or delete lock files.
3. Explain that package RPM scriptlets run with system privileges.
4. In a Terminal, use `devel-su` and type the Developer tools SSH/root password locally. For a single command, use `devel-su COMMAND ARGUMENTS...`, e.g. `devel-su /bin/sh /absolute/path/script`. Do not use the standard-su form `devel-su -c 'command'`: this helper executes a command with argv and that form can yield “Failed to exec: No such file or directory”. For intentional shell expressions, use `devel-su /bin/sh -c 'command'`, with careful quoting; direct argv is preferred. [D06]
5. Refresh, check all names, then install. Stop on any refresh or lookup failure.
```sh
# Root prompt, after successful interactive authentication:
pkcon --plain refresh force
LC_ALL=C pkcon --plain --filter '~source' resolve PACKAGE
pkcon --plain install PACKAGE
# Removal is a separate requested operation:
pkcon --plain remove PACKAGE
exit
```
Do not paste install/remove as one sequence; these illustrate different tasks. Keep confirmation enabled. Inspect dependency removals, especially adaptation, graphics, telephony, desktop, package-manager, and base-library packages.

Local RPMs: review origin, architecture, required libraries and scriptlets first, then use `pkcon install-local /absolute/path/FILE.rpm` when supported. If it rejects authentication or trust, report that separately from package availability. Do not default to `--allow-untrusted`, `--nodeps`, `--force`, downgrade, reinstall, or vendor-change flags.

## SSU repositories

Read-only `ssu lr` may warn ssu.ini is not writable as normal user; this does not itself imply corrupted configuration.

For an explicitly requested custom repo, authenticated root:
```sh
ssu ar UNIQUE-REPO-NAME 'https://trusted.example/matching-repository/'
ssu ur
pkcon --plain refresh force
ssu lr
pkcon --plain repo-list
```
Confirm the URL is real/trusted and matches the phone's OS/architecture before executing. These are templates, not a repository to install.

Management:
- `ssu dr NAME`: disable
- `ssu er NAME`: enable
- `ssu rr NAME`: remove
- follow mutations with `ssu ur`, PackageKit refresh, and read-back verification.

Never override **global** adaptation/OS/feature repo names with custom user repos. Do not copy SSU credential sections or enabled global repos into user repo configuration. SSU commands can return success even if a change did not take effect; verify actual state. [D04, D09]

Repository output/URLs can contain credentials or tokens. Sanitize userinfo and query strings before saving/sharing; do not dump ssu.ini or repo credentials files.

## Jolla Store, Chum, OpenRepos

- **Jolla OS/store repos**: official OS/device/feature content, some authenticated/licensed. Keep the device's existing release/hardware configuration.
- **SailfishOS:Chum**: community source-built RPMs, compiled through OBS for OS and architecture combinations. Chum is not a Jolla official OS repository. [D08]
- **OpenRepos**: community publisher repositories; Storeman is a community client. Publisher binaries have a different trust/build model from Chum. Do not bulk-enable all publishers as a substitute for a package-specific repo.
- Testing repositories are separate and must not be enabled implicitly.

Preferred Chum configuration: current upstream `sailfishos-chum-repo-config` **or** `sailfishos-chum-gui`, not both (conflicts are intentional). Read the current helper's dependencies, scriptlets, release and source. It generates a version-aware SSU configuration. [D08, D09]

Upstream repo-config source uses:
- before SFOS 4.6.0: `%(release)_%(arch)`;
- 4.6.0 and newer: `%(releaseMajorMinor)_%(arch)`.
An RPM spec doubles percent signs to escape macros; the effective SSU URL has single percent signs. For an explicitly selected 5.2/aarch64 target, an example stable URL is (verify availability):
`https://repo.sailfishos.org/obs/sailfishos:/chum/5.2_aarch64/`.

Prefer the supported helper rather than hardcoding URLs. New SFOS releases may temporarily lack Chum builds; a valid repo-config install does not guarantee every desired package has been built. Never “fix” a missing package by choosing a different OS/architecture without compatibility review.

## OS updates are a separate workflow

Use **Settings → System → Sailfish OS updates** by default. Read the target release notes and current official instructions first. Mandatory **stop releases** must not be skipped. Ensure backup, account/licence where applicable, accurate clock, charger, network and enough **root** storage (a large /home does not imply root has space). Review third-party repos and patched/sideloaded system packages. [D05]

`ssu release` with no new argument is a query; a new argument changes release configuration. `version --dup` performs an OS distribution upgrade, not metadata refresh. Neither belongs in a routine install shortcut.

If CLI updating/recovery is explicitly requested, follow the current supported release path and hardware instructions. Do not substitute `pkcon update`, `zypper dup`, or a copied outdated release number for the official process. Never rebuild the RPM database or delete upgrade caches just because one package lookup failed.

## Failure triage

| Symptom | Next safe step |
|---|---|
| command not found | Check PATH/tool presence; choose pkcon before optional zypper |
| Failed to obtain authentication | Identify normal user/root and interactive session; stop and give terminal instructions |
| devel-su auth/token error | Check Developer tools flow with user; don't guess/bypass root credentials |
| devel-su Failed to exec / No such file | Check command argv and actual paths; remove inappropriate su-style -c, or explicitly invoke /bin/sh -c; not automatically a password error |
| resolve exits 0, empty Results | Package missing from current metadata; inspect enabled repos and exact name |
| repo refresh fails | Preserve error; check time/TLS/network/release match; don't continue blindly |
| HTTP 401/403 from official store | Check account/licence/SSU authorization through documented settings; don't print tokens |
| dependencies or conflicts | Review package source/version/architecture; never force/nodeps as default |
| no space | Measure the filesystem containing target/cache; propose scoped cleanup, not mass deletions |
