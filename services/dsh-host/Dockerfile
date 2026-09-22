FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/workbench
COPY packages ./packages
COPY profiles/workbench ./profiles/workbench
RUN cd profiles/workbench && npm ci --no-audit --no-fund
COPY services/dsh-host/start.sh /usr/local/bin/start-workbench
COPY services/dsh-host/relay.mjs /opt/workbench/relay.mjs
RUN chmod 755 /usr/local/bin/start-workbench && mkdir -p /srv/dsh && chown node:node /srv/dsh
USER node
ENV DSH_HOME=/srv/dsh
EXPOSE 3081
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/start-workbench"]
