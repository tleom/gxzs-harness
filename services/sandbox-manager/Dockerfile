FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS docker-cli
FROM python:3.12.10-slim@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/tleom/gxzs-harness" \
      org.opencontainers.image.revision=$VCS_REF
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY global_memory.py ./
RUN python global_memory.py --install
COPY server.py file_ops.py resource_ops.py environment.py stop_jobs.py office_preview.py planning.py planning_exec.py ./
COPY mcp_ops.py mcp_worker.py mcp_runtime.py mcp_journal.py ./
COPY hosts.py admission.py owner_auth.py mcp_authorization.py ./
COPY memory_exec.py ./
EXPOSE 5010
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD python -c "import socket; socket.create_connection(('127.0.0.1',5010),2).close()"
CMD ["python", "server.py"]
