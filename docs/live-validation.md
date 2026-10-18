# Live validation runbook

This runbook validates one disposable user host and sandbox. Do not use a production user's workspace. Stop at the first failed gate.

## 1. Required values

On the Linux host that can reach the sandbox Docker network, export values without writing them to files:

```bash
export HARNESS=/path/to/gxzs/harness
export GXZS_VALIDATION_ROOT=/srv/gxzs/harness-validation
export DSH_HOME="$GXZS_VALIDATION_ROOT/user-42"
export GXZS_HOST_OWNER_ID='<tenant-id>:<user-id>'
export GXZS_ASSERTION_ISSUER='gxzs'
export GXZS_ASSERTION_SIGNING_KEY='<base64 key, at least 32 decoded bytes>'

export GXZS_SANDBOX_WORKSPACE='/workspace'
export GXZS_SANDBOX_SSH_HOST='gxzs-validation-sandbox'
export GXZS_SANDBOX_NODE='/usr/local/bin/node'
export GXZS_SANDBOX_HELPER='/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'
export GXZS_SANDBOX_HELPER_HASH='<64 lowercase hex characters>'

export GXZS_SANDBOX_MANAGER_URL='http://workbench-sandbox-manager:5010'
export GXZS_SANDBOX_MANAGER_TOKEN='<manager bearer token>'
export GXZS_SANDBOX_WORKSPACE_ID='<disposable user workspace UUID>'

export DSH_TELEMETRY_DISABLED=1
# Production omits DSH_PERMISSION_MODE and uses danger-full-access. Set this
# temporary override only for the section 7 confinement test.
export DSH_PERMISSION_MODE=workspace-write
```

Also export the model provider variables required by the selected DSH model profile. Do not place API keys in `settings.yaml`, the sandbox, command history or validation output.

`GXZS_SANDBOX_SSH_HOST` is an OpenSSH alias, not a raw `host:port`. Its SSH config must pin the expected host key and use a dedicated validation key. Do not use `StrictHostKeyChecking=no`.

## 2. Install the locked profile

The preparation script replaces `profiles/workbench` and the bundled package directories under the selected `$DSH_HOME`. Use a disposable validation home only. The home must be a strict descendant of `$GXZS_VALIDATION_ROOT`, with no overlap with the source repository. GNU `realpath` is required to resolve symlinked parents before checking this boundary.

A new or empty home receives a path-bound `.gxzs-disposable-validation-home` marker. Repeated preparations require that marker to match the resolved home path. Existing nonempty, unmarked homes, copied markers from another path, and symlinked `profiles`, `packages`, or `scripts` directories are rejected before replacement. Select a fresh disposable home for an old unmarked validation installation:

```bash
sh "$HARNESS/scripts/prepare-live-home.sh"
```

The script preserves the relative `profiles/` and `packages/` layout required by the locked `file:` dependencies, then runs `npm ci`. A production image must package these plugins as immutable artifacts instead of retaining source-relative dependencies.

## 3. Verify the DSH configuration before startup

```bash
cd "$HARNESS"
DSH_HOME="$DSH_HOME" "$DSH_HOME/profiles/workbench/node_modules/.bin/dsh" \
  --profile workbench --dump-config > /tmp/gxzs-dsh-config.yml 2> /tmp/gxzs-dsh-config.err

test "$(grep -ci mismatch /tmp/gxzs-dsh-config.err || true)" = 0
grep -A3 -E 'gxzs-(ssh|fs-ssh|sandbox-ssh|subprocess-ssh|workbench-adapter|workbench-file-manager)' \
  /tmp/gxzs-dsh-config.yml
```

Pass conditions:

- each gxzs SSH/provider row appears exactly once;
- base `sandbox`, `fs-sandbox` and `subprocess` rows are disabled;
- `sandbox-policy.workspaceRoot` is `/workspace`;
- `session-telemetry-otel` is disabled;
- no `name mismatch` warning exists.

## 4. Verify sandbox helper and Landlock directly

Before starting DSH, the user sandbox must expose the Linux-installed profile dependency tree read-only at `/opt/dsh/node_modules` (or an equivalent immutable helper closure) and must run an SSH server reachable through the configured alias. If the current sandbox-manager does not mount that closure or start SSH, stop here and add those deployment prerequisites first; the profile cannot repair a sandbox container after creation.

Verify the helper file and its exact digest inside the sandbox:

```bash
ssh "$GXZS_SANDBOX_SSH_HOST" \
  "test -f '$GXZS_SANDBOX_HELPER' && sha256sum '$GXZS_SANDBOX_HELPER' && node --version"
```

The digest must equal `GXZS_SANDBOX_HELPER_HASH` exactly.

Use the repository's sandbox verifier if it is installed in the validation image. Otherwise perform these minimum checks through SSH as the sandbox user:

```bash
ssh "$GXZS_SANDBOX_SSH_HOST" 'test -w /workspace && test ! -w /etc'
```

This is only a preflight. The authoritative confinement check is the DSH tool execution in section 7.

## 5. Start the real DSH host

Start it in a supervised shell or service manager. The host must share network reachability with the sandbox SSH endpoint and sandbox-manager, but the DSH HTTP port must not be reachable from the sandbox network.

```bash
cd "$HARNESS"
"$DSH_HOME/profiles/workbench/node_modules/.bin/dsh" \
  --profile workbench --port 3080 --no-open
```

Pass conditions:

- startup reaches ready state;
- SSH helper digest validation succeeds;
- no `SandboxUnavailableError`, duplicate service or injection error appears;
- the adapter opens `$DSH_HOME/workbench.sqlite3`;
- no outbound telemetry request appears.

Keep this process running for the remaining steps.

## 6. Smoke-test authenticated HTTP

For direct host testing, generate a one-use assertion. The signed target must use the Java gateway upstream path, not `/ai/workbench`:

```bash
TOKEN=$(node "$HARNESS/scripts/sign-request.mjs" \
  GET '/console/api/workbench/identity' '' 'application/json' '')

curl --fail-with-body \
  -H "X-GXZS-Assertion: $TOKEN" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:3080/ai/workbench/identity
```

Expected: HTTP 200 and the configured tenant/user. Reusing the same assertion must fail with HTTP 401. A newly signed assertion for another owner must fail with HTTP 403.

For browser validation, route through the Java gateway instead of generating assertions manually.

## 7. Real model and remote sandbox run

Create a chat through the Java gateway or with separately signed one-use requests, then submit this prompt:

```text
Run `hostname; pwd` with bash. Read /etc/os-release. Write exactly `gxzs-harness-ok` to /workspace/harness-validation/result.txt. Read it back. Then try to write /etc/gxzs-harness-denied and report the structured error without retrying or bypassing it.
```

Pass conditions:

- hostname is the user sandbox, not the DSH host;
- pwd is `/workspace`;
- `/workspace/harness-validation/result.txt` exists in the user sandbox and reads back correctly;
- the `/etc` write is denied by the sandbox policy;
- the denial is classified as file access denied, not a generic helper failure;
- no file appears at `/etc/gxzs-harness-denied`;
- run ends `completed` with tool start/result cards and context usage.

After the confinement test, remove `DSH_PERMISSION_MODE` and restart the disposable host to validate the production default `danger-full-access`. The product UI exposes no permission selector; isolation relies on the per-user sandbox, fixed workspace manager, owner binding and network/credential boundaries.

Stop if any command executes on the DSH host filesystem.

## 8. Validate sandbox-manager file mutations

The script creates a unique disposable directory, uploads four binary bytes, verifies stale-version conflict, deletes the file and removes the empty directory:

```bash
node "$HARNESS/scripts/validate-manager.mjs"
```

Expected output:

```json
{"ok":true,"prefix":"harness-validation-...","conflict":true}
```

Also verify in sandbox-manager logs that every request targeted exactly `GXZS_SANDBOX_WORKSPACE_ID`. No token or file data should be logged.

## 9. Validate SSE resume

Submit a run that performs several tool calls. Start events with cursor `0-0`, record the latest `id: N-0`, disconnect, then reconnect with a newly signed assertion whose `last_event_id` claim and `Last-Event-ID` header both equal that cursor.

Pass conditions:

- no event with sequence `<= N` is replayed;
- no sequence is skipped;
- keepalive comments do not change the cursor;
- `workbench_end` has its own cursor and is delivered once;
- reconnecting after the terminal cursor returns no duplicate terminal event.

## 10. Validate human input

Prompt:

```text
Use ask_user_question to ask which environment to deploy to, with staging and production choices. Continue only after the answer.
```

In the existing Vue UI through the Java gateway:

1. wait for the question panel;
2. refresh the page and confirm the same pending question returns;
3. choose staging and submit;
4. submit the same answer from a second tab;
5. repeat with another run and test skip;
6. repeat and leave it untouched for the configured timeout.

Pass conditions:

- normal answer resumes exactly once;
- duplicate submit is idempotent;
- skip/timeout returns `ASK_CANCELLED` to the model and the run settles;
- refresh does not duplicate the question;
- no pending panel remains after terminal state.

## 11. Validate followup and control

While a long run is executing:

1. queue a second message;
2. verify followup polling returns it;
3. edit/remove it through the queue endpoint;
4. queue another message and steer it into the active run;
5. issue `/goal`, `/plan`, `/compact` and clear todos.

Pass conditions:

- queue mutations use the DSH message id;
- delayed events remain attached to the correct adapter run;
- request-key retries do not execute commands twice;
- control revision increases monotonically;
- followup, control and SSE views converge after refresh.

## 12. Evidence to retain

Retain only non-secret evidence under a task-specific directory:

- sanitized DSH startup log;
- `--dump-config` output with environment values redacted;
- run/chat IDs and SSE cursors;
- sandbox hostname and result-file content;
- manager validation JSON;
- browser screenshots for tool cards, human input and followup/control states.

Never retain assertion signing keys, model API keys, SSH private keys, manager tokens or raw legal case content.
