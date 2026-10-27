# Apps, permissions, Android support, and development

## Native application stack

Sailfish is GNU/Linux with Qt/QML/Qt Quick native applications and Sailfish Silica controls. Lipstick provides homescreen, window management/compositing, launch and lifecycle handling; graphics typically use Wayland, EGL/OpenGL ES. It is not a normal GNOME/KDE/X11 session and not Android/Bionic userland. Native or libhybris-based hardware adaptation bridges are device-dependent. [D01, D02]

Do not promise every desktop GUI app will run because the kernel is Linux. Qt modules, display plugins, window conventions, keyboard/input, shared libraries and app sandboxing differ. **Qt 6 and recent Qt 5 APIs cannot be assumed**. Query the actual installed Qt RPMs and SDK target before using version-specific APIs.

## Discover an app rather than guessing paths

```sh
rpm -qf /usr/bin/APP-BINARY
rpm -ql APP-PACKAGE
# Read the actual /usr/share/applications/APP.desktop with the agent read tool.
```
Desktop entries use the freedesktop format plus Sailfish extensions. Inspect Desktop Entry/Exec, X-Sailjail, OrganizationName, ApplicationName, Permissions, and possibly ExecDBus/DBusActivatable. Desktop field codes and launcher arguments are not general shell syntax: **never eval an Exec line**. A desktop filename may differ from the executable. [D16]

Use the installed launcher's documented interface; Check whether `invoker` is installed; do not assume its flags. Prefer a verified Sailjail reproduction for permission failures rather than starting as root.

## Sailjail and protected data

Sailjail wraps Firejail and has a permission-management daemon. Permission profiles are requested by the app's desktop entry. Launcher execution, direct terminal execution, and IDE execution can differ. Direct binary/IDE execution is not necessarily sandboxed unless you use the wrapper. [D07, D19, D20]

For a known app whose permissions the user has approved:
```sh
# Device, as normal user; launch a selected app only when requested:
sailjail /usr/bin/harbour-myapp
# If the desktop filename differs, after inspecting that installed entry:
sailjail -p harbour-myapp.desktop -- /usr/bin/harbour-myapp
```
These are example app names, not installed-app assumptions. Use absolute binary paths. Do not globally set Sandboxing=Disabled as a workaround.

An explicit profile commonly contains:
```ini
[X-Sailjail]
OrganizationName=org.example
ApplicationName=MyApp
Permissions=Internet;Pictures;
```
This is illustrative, not a reason to grant all permissions. Derive the minimum required permissions from actual app functionality and the current permission catalogue. OrganizationName/ApplicationName also determine the app's permitted session-bus name and private XDG directories:
- `$HOME/.local/share/<OrganizationName>/<ApplicationName>`
- `$HOME/.config/<OrganizationName>/<ApplicationName>`
- `$HOME/.cache/<OrganizationName>/<ApplicationName>`

Pictures/Documents/Music/Videos require the corresponding permission rather than implicit access to the whole home. Legacy data migration needs an app-specific plan; do not relocate all user configuration at once.

Sailfish can protect sensitive data with the `privileged` owner/group even inside the user's home. Unix group access, Firejail namespaces/profiles, D-Bus filtering, and root privileges are separate layers. Sandboxed privileged apps have special real-group/no-new-privs behavior. Neither running as root nor recursive chmod is an acceptable normal fix. [D19]

From SFOS 4.4, apps without explicit profiles can receive a default relaxed profile; some apps explicitly opt out. “Every process is always jailed” is false. Inspect the entry/config and reproduction mode. [D20]

## SDK builds (desktop host / SDK, not the phone)

Prefer matching Sailfish SDK targets or OBS builds over installing compilers/devel packages into the phone's base runtime. App SDK (`sfdk`) and Platform SDK (`sb2` workflows) are different tools/environments; follow the relevant installed SDK documentation. Emulator architecture differs from physical phones. [D10, D11]

Typical App SDK workflow, **on the SDK host**:
```sh
sfdk tools list
# Choose an actually installed target matching the intended release and arch:
sfdk config --push target SailfishOS-RELEASE-aarch64
# In the source repository with its RPM spec:
sfdk build
# RPM outputs are under ./RPMS
```
Use current `sfdk --help` and `sfdk --help-building` for exact installed-SDK options. The target above is a placeholder, not a release that exists.

Packages commonly use `rpm/*.spec` and tar_git-style sources; BuildRequires install build dependencies in the target. Inspect source/submodules/spec/patches. Clean target builds detect missing dependencies better than a pre-populated phone. Cross-compilation must match ABI/Qt/modules, not just CPU architecture.

`sfdk deploy --manual` can transfer built RPMs to a registered device; device installation is a separately authorized operation. Review RPM origin, dependencies and versioning first. The vendor deployment page has force/no-gpg/distro-upgrade examples for controlled development; **do not copy those flags as the default production-phone workflow**. Prefer dependency-aware pkcon installation of reviewed files. [D11]

Harbour/Jolla Store apps have supported-API and packaging restrictions that differ from unrestricted community packages. If publishing there, read current Harbour rules; a successful Chum build is not proof of Harbour eligibility.

## Native binary compatibility

Aarch64 is a CPU architecture, not a universal ABI promise. Check:
- `uname -m` and RPM arch;
- ELF interpreter/linked libraries with installed file/readelf tools, if present;
- target glibc and C++ ABI, Qt version/plugins;
- desktop/session/Sailjail expectations.

Do not use `ldd` on an untrusted executable as a security-neutral inspection step; prefer readelf when available. Do not install Ubuntu/Fedora RPMs or Android/Termux binaries into Sailfish just because they share ARM hardware. glibc and Bionic are distinct. Optional user-space runtimes may be available, but verify trust and runtime requirements rather than replacing system libraries.

## Android AppSupport

AppSupport is a separate Android compatibility environment, with device/licence/version-dependent availability, not the native package system. APKs are not RPMs; apt in a container does not configure Sailfish repositories. Native hardware adaptation's Android HAL use is not the same thing as running Android apps. [D01, D14]

Current documentation describes:
- app internals under `/home/.appsupport/instance/<user>/data/data`;
- user-facing files under `$HOME/android_storage`, including Android/data and media/downloads.

Older paths and implementations can differ. Verify actual mounts/processes and installed packages if the user asks to work with AppSupport. Never infer active AppSupport from one directory or a repo named aliendalvik.

Do not recurse into Android private app data, change its ownership, clear all AppSupport state, or restart its container for an unrelated native problem. APKs, app stores and remote services add independent trust/privacy risks; no implication that Google Play/services or a particular Android version is available.

## Config/data changes

Use app-specific APIs/settings first. If editing a config is explicitly needed: determine owning process/group/namespace, back up the precise file, check whether stopping the app is required, modify minimally, restart only that app if authorized, and verify. User contacts, accounts, calls, calendar, messages and credentials require explicit task scope.
