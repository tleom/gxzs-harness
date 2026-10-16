FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS browser-client
WORKDIR /build
COPY services/browser-client/package*.json ./
RUN npm ci --no-audit --no-fund
COPY services/browser-client/build.mjs ./
RUN node build.mjs /dist

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
RUN node -e "require('fs').mkdirSync('/etc/ssl/certs',{recursive:true});require('fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('tls').rootCertificates.join('\n'))" \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends openssh-client tini ca-certificates \
      fontconfig fonts-dejavu-core fonts-liberation fonts-noto-cjk \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/workbench
COPY packages ./packages
COPY --from=browser-client /dist/ ./services/browser-client/dist/
COPY profiles/workbench ./profiles/workbench
COPY scripts/prepare-workspace-changes.mjs /opt/workbench/scripts/prepare-workspace-changes.mjs
COPY scripts/prepare-session-client.mjs /opt/workbench/scripts/prepare-session-client.mjs
COPY scripts/prepare-subagent-prompt.mjs /opt/workbench/scripts/prepare-subagent-prompt.mjs
COPY scripts/prepare-dsh-stream-arguments.mjs /opt/workbench/scripts/prepare-dsh-stream-arguments.mjs
COPY scripts/prepare-dsh-agent-inbox.mjs /opt/workbench/scripts/prepare-dsh-agent-inbox.mjs
COPY scripts/prepare-session-references.mjs /opt/workbench/scripts/prepare-session-references.mjs
COPY scripts/prepare-workbench-client.mjs /opt/workbench/scripts/prepare-workbench-client.mjs
COPY scripts/native-settings-controllers.mjs /opt/workbench/scripts/native-settings-controllers.mjs
COPY scripts/migrate-platform-patch.mjs /opt/workbench/scripts/migrate-platform-patch.mjs
COPY scripts/prepare-sidebar-terminal.mjs /opt/workbench/scripts/prepare-sidebar-terminal.mjs
COPY scripts/check-runtime-imports.mjs ./check-runtime-imports.mjs
COPY scripts/patch-dsh-skill-catalog.mjs /opt/workbench/scripts/patch-dsh-skill-catalog.mjs
COPY scripts/check-dsh-skill-catalog.mjs /opt/workbench/scripts/check-dsh-skill-catalog.mjs
RUN ln -s profiles/workbench/node_modules /opt/workbench/node_modules \
    && cd profiles/workbench && npm ci --no-audit --no-fund \
    && node /opt/workbench/scripts/patch-dsh-skill-catalog.mjs \
    && node /opt/workbench/scripts/prepare-sidebar-terminal.mjs \
    && node /opt/workbench/scripts/check-dsh-skill-catalog.mjs \
    && node /opt/workbench/check-runtime-imports.mjs
COPY services/dsh-host/start.sh /usr/local/bin/start-workbench
COPY services/dsh-host/relay.mjs /opt/workbench/relay.mjs
# Native session creation ensures its cwd locally before mounting SSH tools.
# This empty directory holds only cwd placeholders; user files stay in the sandbox.
RUN chmod 755 /usr/local/bin/start-workbench && mkdir -p /srv/dsh /workspace && chown node:node /srv/dsh /workspace
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/tleom/gxzs-harness" \
      org.opencontainers.image.revision=$VCS_REF
USER node
ENV DSH_HOME=/srv/dsh
EXPOSE 3081
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3081/ai/workbench/health').then(async r=>{if(!(await r.json()).live)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/start-workbench"]
