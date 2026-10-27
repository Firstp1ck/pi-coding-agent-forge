# Target capability checks

This package deliberately contains no personal device snapshot. Capture only what the current task requires and keep observations in a private host/harness memory store, outside the installed package.

## Confirm context

Identify device versus SDK versus host, read `/etc/os-release`, and discover the real username, UID, architecture, shell implementation, and tool availability. Re-query versions and service state on every new target; an OS release number does not imply a specific Qt, glibc, BusyBox, or systemd version.

## Device-only inventory

Run the reviewed `../scripts/inspect.sh` on the Sailfish device as its normal user with an explicit timeout. It does not refresh repositories, change files, elevate, or dump logs. The helper reports only presence of selected session variables, not their values, and redacts repository URL userinfo/query/fragment text. Review output before sharing; hostnames, user names, service states, and storage are still operational data.

## Before a requested change

Confirm actual package/repository state, exact release/architecture, transaction status, storage on the affected filesystem, stable power/network access, and permitted authentication flow. Inspect any existing user-created wrappers before trusting them; this package installs none. A downloaded RPM is not proof of installation or repository activation. Root access in a previous tool call is not permission for a new mutation.
