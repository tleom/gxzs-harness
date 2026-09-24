FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/tleom/gxzs-harness" \
      org.opencontainers.image.revision=$VCS_REF
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/workbench
COPY packages ./packages
COPY profiles/workbench ./profiles/workbench
COPY scripts/check-runtime-imports.mjs ./check-runtime-imports.mjs
RUN cd profiles/workbench && npm ci --no-audit --no-fund \
    && ln -s profiles/workbench/node_modules /opt/workbench/node_modules \
    && node /opt/workbench/check-runtime-imports.mjs
COPY services/dsh-host/start.sh /usr/local/bin/start-workbench
COPY services/dsh-host/relay.mjs /opt/workbench/relay.mjs
# Native session creation ensures its cwd locally before mounting SSH tools.
# This empty directory holds only cwd placeholders; user files stay in the sandbox.
RUN chmod 755 /usr/local/bin/start-workbench && mkdir -p /srv/dsh /workspace && chown node:node /srv/dsh /workspace
USER node
ENV DSH_HOME=/srv/dsh
EXPOSE 3081
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3081/ai/workbench/health').then(async r=>{if(!(await r.json()).live)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/start-workbench"]
