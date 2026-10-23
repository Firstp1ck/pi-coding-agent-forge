# Base image for the docker-linux backend of @firstpick/pi-extension-gui-testing.
#
# Build context: a staged tar stream holding only package tooling, never a
# project directory (spec §4.1):
#   Dockerfile, helper, pi_gui_helper/   from helpers/linux/
#   testapps/gtk3-smoke/                 from testapps/gtk3-smoke/
# tests/helper/host/build_image.py builds that stream and pipes it to
#   docker build --build-arg PACKAGE_VERSION=<version> --build-arg PROTOCOL_VERSION=1 -t <tag> -
# A stream works with the legacy builder and BuildKit alike, so hosts without
# the buildx plugin can build it.

# Pinned dated tag plus digest, so rebuilds start from the same Debian snapshot.
FROM debian:trixie-20261020-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

ARG PACKAGE_VERSION=0.0.0-dev
ARG PROTOCOL_VERSION=1

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini ca-certificates \
      xvfb xauth x11-utils xdotool imagemagick openbox \
      dbus dbus-x11 at-spi2-core \
      python3 python3-gi python3-gi-cairo python3-pyatspi python3-tk \
      gir1.2-gtk-3.0 gir1.2-gtk-4.0 gir1.2-atspi-2.0 \
      python3-pip python3-venv nodejs npm \
      fonts-dejavu-core fonts-liberation2 fonts-noto-core \
      libxcb-cursor0 libxkbcommon-x11-0 libxcb-icccm4 libxcb-keysyms1 \
      libxcb-render-util0 libxcb-image0 libxcb-randr0 libxcb-shape0 \
      libxcb-xinerama0 libxcb-xkb1 libegl1 libgl1 libfontconfig1 libdbus-1-3 \
      libnss3 libatk-bridge2.0-0t64 libgtk-3-0t64 libgbm1 libasound2t64 \
      libxss1 libdrm2 libxshmfence1 libxtst6 libxrandr2 libxcomposite1 \
      libxdamage1 libcups2t64 \
 && rm -rf /var/lib/apt/lists/*

# Run as an arbitrary --user UID: /etc/passwd and /etc/group are bind-mounted
# by the client, and every writable path is a tmpfs, so nothing here may assume
# a fixed user or write outside those mounts.
COPY helper /opt/pi-gui-testing/helper
COPY pi_gui_helper/ /opt/pi-gui-testing/lib/pi_gui_helper/
COPY testapps/gtk3-smoke/ /opt/pi-gui-testing/testapps/gtk3-smoke/

RUN mkdir -p /workspace /scratch /deps /home/app \
 && chmod -R u=rwX,go=rX /opt/pi-gui-testing \
 && chmod 0755 /opt/pi-gui-testing/helper /opt/pi-gui-testing/testapps/gtk3-smoke/app.py \
 && python3 -c "import gi, pyatspi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk"

LABEL pi-gui-testing.base="true" \
      pi-gui-testing.version="${PACKAGE_VERSION}" \
      pi-gui-testing.protocol="${PROTOCOL_VERSION}"

WORKDIR /workspace
ENTRYPOINT ["tini", "--", "/opt/pi-gui-testing/helper"]
