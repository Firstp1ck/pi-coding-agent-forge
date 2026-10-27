#!/bin/sh
# Query only: never refresh, elevate, install, remove, or change a repository.
export LC_ALL=C
usage() {
    printf '%s\n' "Usage: package-available.sh PACKAGE [PACKAGE ...]" \
        "Query cached non-source matches; 0=all found, 3=missing, 2=usage, 1=query/tool failure."
}
case "${1-}" in
    -h|--help) usage; exit 0 ;;
esac
if [ "$#" -eq 0 ]; then usage >&2; exit 2; fi
# Validate all arguments before issuing any query.
for package do
    case "$package" in
        ''|-*|*[!A-Za-z0-9+_.-]*)
            printf 'Invalid package name: %s\n' "$package" >&2
            exit 2 ;;
    esac
done
if ! pkcon_path=$(command -v pkcon); then
    printf '%s\n' "pkcon unavailable on PATH; no query performed." >&2
    exit 1
fi
missing=0
for package do
    if output=$("$pkcon_path" --plain --filter '~source' resolve "$package" 2>&1); then
        printf '\n== %s ==\n%s\n' "$package" "$output"
    else
        printf '%s\n' "$output" >&2
        printf 'Query failed for %s; availability is unknown.\n' "$package" >&2
        exit 1
    fi
    if ! printf '%s\n' "$output" | grep -Eq '^(Available|Installed)[[:space:]]'; then
        printf 'No installed or available non-source match: %s\n' "$package" >&2
        missing=1
    fi
done
[ "$missing" -eq 0 ] || exit 3
exit 0
