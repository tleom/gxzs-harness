ARG WORKBENCH_FONT_IMAGE=system-fonts
FROM scratch AS system-fonts
COPY services/sandbox/fonts/system-manifest.json /fonts/manifest.json
FROM ${WORKBENCH_FONT_IMAGE} AS workbench-fonts

# Build from the repository root. The upstream digest supplies Python 3.12,
# the dify UID 1000 account and the compatibility shellctl endpoint.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS dsh-dependencies
WORKDIR /opt/workbench
COPY packages ./packages
COPY profiles/workbench ./profiles/workbench
COPY scripts/prepare-workspace-changes.mjs /opt/workbench/scripts/prepare-workspace-changes.mjs
COPY scripts/prepare-session-client.mjs /opt/workbench/scripts/prepare-session-client.mjs
COPY scripts/prepare-subagent-prompt.mjs /opt/workbench/scripts/prepare-subagent-prompt.mjs
COPY scripts/prepare-dsh-stream-arguments.mjs /opt/workbench/scripts/prepare-dsh-stream-arguments.mjs
COPY scripts/prepare-dsh-agent-inbox.mjs /opt/workbench/scripts/prepare-dsh-agent-inbox.mjs
COPY scripts/prepare-terminal-cleanup.mjs /opt/workbench/scripts/prepare-terminal-cleanup.mjs
COPY scripts/prepare-session-references.mjs /opt/workbench/scripts/prepare-session-references.mjs
COPY scripts/prepare-workbench-client.mjs /opt/workbench/scripts/prepare-workbench-client.mjs
COPY scripts/native-settings-controllers.mjs /opt/workbench/scripts/native-settings-controllers.mjs
COPY scripts/check-runtime-imports.mjs ./check-runtime-imports.mjs
RUN ln -s profiles/workbench/node_modules /opt/workbench/node_modules \
    && cd profiles/workbench && npm ci --no-audit --no-fund \
    && node /opt/workbench/check-runtime-imports.mjs

FROM langgenius/dify-agent-local-sandbox@sha256:f4d404c9dcdf80bd72f65e84c3f2bbd1f3404fd4b363db837176da8aaf771b1d
ARG PIP_INDEX_URL=https://pypi.org/simple
USER root
ARG KASMVNC_VERSION=1.5.0
ARG KASMVNC_SHA256=770fd3df51510beecc89666879d82faf411276e68c6e11df612f736b891b5f71
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome \
    CHROME_BIN=/usr/bin/google-chrome LANG=C.UTF-8 PYTHONIOENCODING=utf-8 MPLBACKEND=Agg
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends \
      openssh-server tini bubblewrap ca-certificates curl unzip zip jq ripgrep git file \
      xauth x11-utils x11-xserver-utils \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw libreoffice-math python3-uno \
      poppler-utils fontconfig fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu-core fonts-liberation \
      fonts-crosextra-carlito fonts-crosextra-caladea pandoc ghostscript qpdf \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim chromium \
      ffmpeg libimage-exiftool-perl p7zip-full unrar-free gcc libc6-dev graphviz librsvg2-bin \
      imagemagick sqlite3 antiword libmagic1 libcairo2 libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
    && ln -sf /usr/bin/chromium /usr/bin/google-chrome \
    && mkdir -p /run/sshd /workspace /opt/user-env \
    && chown 1000:1000 /workspace /opt/user-env \
    && fc-cache -f && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 3 --connect-timeout 20 --max-time 300 \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_amd64.deb" -o /tmp/kasmvnc.deb \
    && echo "${KASMVNC_SHA256}  /tmp/kasmvnc.deb" | sha256sum -c - \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
    && rm /tmp/kasmvnc.deb && rm -rf /var/lib/apt/lists/*
COPY --from=dsh-dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=workbench-fonts /fonts/ /usr/local/share/fonts/workbench/
RUN fc-cache -f /usr/local/share/fonts/workbench
COPY services/sandbox/office /opt/office
COPY services/sandbox/office/package.json services/sandbox/office/package-lock.json /opt/office/node/
COPY services/sandbox/mcp-requirements.lock.txt /opt/workbench-mcp-requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    /usr/local/bin/python -m venv /opt/office/python \
    && /opt/office/python/bin/pip install --timeout 120 -r /opt/office/requirements.lock.txt \
    && /opt/office/python/bin/pip check
RUN --mount=type=cache,target=/root/.cache/pip \
    /usr/local/bin/python -m venv /opt/workbench-mcp \
    && /opt/workbench-mcp/bin/pip install --timeout 120 -r /opt/workbench-mcp-requirements.txt \
    && /opt/workbench-mcp/bin/pip check
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefix /opt/office/node --no-fund --no-audit \
    && npm ci --prefix /opt/office/mermaid --no-fund --no-audit \
    && chmod 755 /opt/office/bin/mmdc.sh \
    && ln -sf /opt/office/bin/mmdc.sh /opt/office/node/node_modules/.bin/mmdc \
    && gcc -shared -fPIC -O2 -Wall -Wextra -Werror /opt/office/private_ipc.c -ldl -o /opt/office/private_ipc.so \
    && dpkg-query -W > /opt/office/system-packages.txt \
    && chown -R 0:0 /usr/local /opt/office /opt/workbench-mcp \
    && chmod -R go-w /usr/local /opt/office /opt/workbench-mcp
COPY --from=dsh-dependencies /opt/workbench /opt/workbench
RUN ln -s /opt/workbench/profiles/workbench /opt/dsh \
    && chown -R 0:0 /opt/workbench && chmod -R go-w /opt/workbench
COPY services/sandbox/entrypoint.sh /usr/local/bin/start-owner-sandbox
COPY services/sandbox/verify-runtime.mjs /opt/workbench/verify-runtime.mjs
RUN chmod 755 /usr/local/bin/start-owner-sandbox \
    && node /opt/workbench/verify-runtime.mjs
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/tleom/gxzs-harness" \
      org.opencontainers.image.revision=$VCS_REF
ENV PATH=/opt/user-env/current/python/bin:/opt/office/python/bin:/opt/user-env/current/node/node_modules/.bin:/opt/office/node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
    NODE_PATH=/opt/user-env/current/node/node_modules:/opt/office/node/node_modules
USER dify
EXPOSE 2222 5004
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD /usr/local/bin/python -I -S -c "import socket; socket.create_connection(('127.0.0.1',2222),2).close()"
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/start-owner-sandbox"]
CMD ["shellctl", "serve", "--listen", "0.0.0.0:5004"]
