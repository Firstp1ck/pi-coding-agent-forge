# Sources and limitations

This reusable guidance derives from Sailfish vendor documentation and maintained upstream sources. Source descriptions inherited from the original local skill are leads, not newly verified current release facts. Check live primary documentation and installed help before unfamiliar or high-impact operations. No personal device snapshot, raw local probes, private helper paths, or research logs are distributed.

Prefer current target observations for installed capabilities, vendor/upstream docs for supported behavior, release notes for changes, and community sources only as verified leads. Publication dates are not inferred from retrieval dates. This is an operational handbook, not exhaustive recovery or hardware-adaptation coverage.

## Primary-source catalogue

**D01 — Architecture**
https://docs.sailfishos.org/Reference/Architecture/
Exact passage: “Sailfish OS is a mobile operating system based on GNU/Linux.” Also: “Application launching and lifetime is controlled by Lipstick”. Establishes layers, Qt/QML, native/libhybris adaptation, phone component chains.

**D02 — Core Areas and APIs**
https://docs.sailfishos.org/Reference/Core_Areas_and_APIs/
Exact passage: “Systemd’s user-session system is used to manage the user executed code, such as the lipstick process.” Lists ConnMan, oFono, BlueZ, graphics/audio, D-Bus, filesystems. Also names glibc 2.30 and GNU tools: example versions are not capability contracts for a current device.

**D03 — SSU**
https://docs.sailfishos.org/Services/Deployment/SSU/
Exact passage: “The on-device software registers with the cloud service and manages the zypper/packagekit repositories using the access tokens provided.” Enumerates release, hardware, geographic, licensed, personal variation.

**D04 — Sailfish OS Cheat Sheet**
https://docs.sailfishos.org/Reference/Sailfish_OS_Cheat_Sheet/
Exact passage: “Zypper commands for SDK (pkcon is preferred on device)”. Documents SSU, PackageKit/RPM queries, user/system service diagnostics. Warning: its force/nodeps, database cleanup and service-restart examples need task-specific review, not blind execution.

**D05 — Updating Sailfish OS**
https://docs.sailfishos.org/Support/Help_Articles/Managing_Sailfish_OS/Updating_Sailfish_OS/
Exact passage: “Stop releases are mandatory intermediate steps in the update path through which the update process must traverse if the current OS version of the device is from the past.” Gives OTA preference, prerequisites, CLI upgrade and third-party-repo troubleshooting. Do not copy its historical release-number examples as current targets.

**D06 — Enabling Developer Mode**
https://docs.sailfishos.org/Support/Help_Articles/Enabling_Developer_Mode/
Exact passages: “Tap on the ‘Set password for SSH and root access’ line and type or generate a password”; “Use your SSH password here” after devel-su. Distinguishes Remote connection and restricted developer-updates setting. Its command example is `devel-su pkcon install nano`, documenting the direct-command form. Do not assume the standard-su `-c` option applies to devel-su.

**D07 — Application Permissions**
https://docs.sailfishos.org/Develop/Apps/Application_Permissions/
Exact passage: “when an application is run from the Sailfish IDE, from terminal or by similar means, sandboxing is not active and the application runs without restrictions unless the Sailjail wrapper is used”. Gives desktop metadata and wrapper example. Some apps explicitly opt out or use default profiles; see D20.

**D08 — Chum user's and developer's guide**
https://github.com/sailfishos-chum/main
Exact passage: “software is compiled and packaged into RPMs in a reproducible manner directly from its source code.” Documents repo-config or GUI, refresh/install, OBS build process and not replacing Jolla libraries.

**D09 — Chum repo-config helper and RPM source**
https://github.com/sailfishos-chum/sailfishos-chum-repo-config
https://raw.githubusercontent.com/sailfishos-chum/sailfishos-chum-repo-config/main/rpm/sailfishos-chum-repo-config.spec
README notes temporary missing builds after a new OS release. Spec shows the >=460 major/minor URL rule, noarch helper, SSU post-install/remove, and conflicts with GUI/testing helper. Do not equate source main with a released downloadable RPM; inspect the current release metadata.

**D10 — SDK: Building packages**
https://docs.sailfishos.org/Tools/Sailfish_SDK/Building_packages/
Exact passage: “Each build target lets you build software for a specific operating system version running on a specific hardware.” Documents sfdk tools list, target selection, build, RPMS, build maintenance vs persistent target operations.

**D11 — SDK: Deploying packages**
https://docs.sailfishos.org/Tools/Sailfish_SDK/Deploying_packages/
Exact passage: “packages installed in this fashion (‘sideloaded’) may cause conflicts with packages installed from repositories.” Documents manual deployment, target/device difference, SSU and pkcon. Its force/no-gpg examples are controlled developer workflows, not this skill's defaults.

**D12 — Locations of Apps**
https://docs.sailfishos.org/Support/Help_Articles/Locations_of_Apps/
Exact passage: “OS release 3.4.0 and later can have either ‘defaultuser’ or ‘nemo’ as the primary user (admin) of Sailfish OS.” Describes protected/private app data. Used for navigation boundaries, not indiscriminate reads.

**D13 — Encryption of User Data**
https://docs.sailfishos.org/Support/Help_Articles/Encryption_of_User_Data/
Documents user-data encryption, LUKS, security-code unlock and differences between newer flashed installs and older upgraded systems. Do not generalize its Xperia boot-logo details to other hardware.

**D14 — Android AppSupport**
https://docs.sailfishos.org/Support/Help_Articles/Android_App_Support/
Exact passage: “the folder /home/.appsupport/instance/defaultuser/data/data has all of your installed Android apps.” Describes user-facing android_storage and version-dependent Android limitations. Paths must be verified locally.

**D15 — SSH/SCP from Linux**
https://docs.sailfishos.org/Support/Help_Articles/SSH_and_SCP/SSH_and_SCP_Linux/
Documents user discovery, Remote connection prerequisites and USB/WLAN transfer. USB example uses 192.168.2.15; not a substitute for observing the current address.

**D16 — Lipstick Launchers**
https://docs.sailfishos.org/Reference/Core_Areas_and_APIs/Apps_and_MW/Lipstick/Launchers/
Documents /usr/share/applications, X-Sailjail, permission approval, namespace identity, ExecDBus, D-Bus activation and release-specific errata.

**D17 — Official Rokua announcement**
https://blog.jolla.com/sailfish-os-rokua-is-now-available/
Exact passage: “In this release we moved coreutils, tar and vi to busybox.” Historical evidence of BusyBox migration; current /bin/bash behavior must be probed, not inferred from this announcement.

**D18 — Sailjail debugging instructions**
https://raw.githubusercontent.com/sailfishos/sailjail/master/APPDEBUG.md
Describes RPM/desktop discovery, wrapper tracing, different privileged-app workflows, existing trace-directory requirement, and log interpretation. Tracing and launch-file changes are separate, explicitly authorized operations.

**D19 — Sailjail source README**
https://github.com/sailfishos/sailjail
Exact passage: “Sailfish OS application sandboxes are launched through sailjail command that is a thin Firejail wrapper.” Lists namespaced XDG directories, permission profiles, daemon and protected-group/no-new-privs handling.

**D20 — Sailjail permission catalogue**
https://github.com/sailfishos/sailjail-permissions
Exact passage: “Since Sailfish OS 4.4.0 all applications that do not specifically opt-out or define permissions are sandboxed automatically using a default profile.” Specifies permissions, profile metadata, migration and sharing.
