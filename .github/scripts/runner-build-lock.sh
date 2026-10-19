#!/usr/bin/env bash
# Source at the start of a heavy step. The shell and its children retain the
# dynamic descriptor until they exit, including when GitHub cancels the step.
# Cache locks use descriptors 8/9; this lock must not reuse either descriptor.
GXZS_RUNNER_BUILD_LOCK_WAIT_SECONDS=0
if [[ "${RUNNER_ENVIRONMENT:-}" == "self-hosted" ]]; then
  GXZS_RUNNER_BUILD_LOCK_STARTED=$SECONDS
  echo "Waiting for the shared runner build lock..."
  exec {GXZS_RUNNER_BUILD_LOCK_FD}>/runner-locks/heavy-build.lock
  flock -x "$GXZS_RUNNER_BUILD_LOCK_FD" || return $?
  GXZS_RUNNER_BUILD_LOCK_WAIT_SECONDS=$((SECONDS - GXZS_RUNNER_BUILD_LOCK_STARTED))
  echo "Shared runner build lock acquired after ${GXZS_RUNNER_BUILD_LOCK_WAIT_SECONDS}s."
fi
