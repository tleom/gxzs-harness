FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS docker-cli
FROM python:3.12.10-slim@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY mcp_outcomes.py global_memory.py ./
RUN python global_memory.py --install
COPY server.py file_ops.py resource_ops.py binary_upload.py file_download.py environment.py stop_jobs.py office_preview.py office_conversions.py planning.py planning_exec.py ./
COPY mcp_ops.py mcp_worker.py mcp_runtime.py mcp_exec.py ./
COPY hosts.py admission.py owner_auth.py mcp_authorization.py resource_limits.py runtime_names.py ./
COPY owner_networks.py docker_inspect.py global_skills.py ./
COPY memory_exec.py ./
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/tleom/gxzs-harness" \
      org.opencontainers.image.revision=$VCS_REF
EXPOSE 5010
HEALTHCHECK --interval=15s --timeout=8s --start-period=45s --retries=3 \
  CMD python -c "import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:5010/healthz',timeout=6); raise SystemExit(0 if r.status==200 else 1)"
CMD ["python", "server.py"]
