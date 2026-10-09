// Adapted from DeepSeek Harness 0.1.7-rc.1 workspace-changes/capture.ts.
// Copyright (c) 2026 DeepSeek. MIT; see ../LICENSE.DeepSeek.
// Keep DSH's bounded whole-file capture in the same sandbox as its Git process.
// The source runs through the existing subprocess provider; no local fallback.
const CAPTURE_SOURCE = String.raw`
const fs = require('node:fs/promises');
const {join} = require('node:path');
const {createHash} = require('node:crypto');
(async () => {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const {absolute, directory, maxBytes} = JSON.parse(input);
  let handle;
  try { handle = await fs.open(absolute, 'r'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {kind:'absent'};
  }
  let bytes;
  try {
    if (!(await handle.stat()).isFile()) return null;
    const probe = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < probe.length) {
      const result = await handle.read(probe, length, probe.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) return {kind:'oversized'};
    bytes = probe.subarray(0, length);
  } finally { await handle.close(); }
  const file = join(directory, createHash('sha1').update(bytes).digest('hex'));
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  await fs.writeFile(file, bytes, {flag:'wx', mode:0o600}).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  return {kind:'file', file, binary:bytes.subarray(0,8000).includes(0)};
})().then(value => process.stdout.write(JSON.stringify({value})), error => {
  process.stdout.write(JSON.stringify({error:{message:error.message,code:error.code}}));
  process.exitCode = 1;
});
`;

/** Native capture semantics, with all byte reads and snapshot writes sandbox-local. */
export async function captureWorkspaceFile(subprocess, {node, cwd, absolute, directory, maxBytes, signal}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024)
    throw new RangeError('Invalid workspace capture byte limit');
  if (!node || !cwd || !absolute || !directory) throw new TypeError('Missing workspace capture path');
  const abort = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  abort.throwIfAborted();
  const handle = subprocess.spawn({
    argv:[node, '-e', CAPTURE_SOURCE], cwd, signal:abort, graceMs:1000,
    stdio:{stdin:{data:JSON.stringify({absolute,directory,maxBytes})},stdout:{maxBytes:16384},stderr:{maxBytes:4096}},
  });
  const outcome = await handle.done;
  abort.throwIfAborted();
  const output = handle.collected.stdout?.readFrom(0);
  if (!output || output.lossy) throw new Error('Workspace capture response missing or truncated');
  let result;
  try { result = JSON.parse(output.text); }
  catch { throw new Error('Invalid workspace capture response'); }
  if (result.error) throw Object.assign(new Error(result.error.message), {code:result.error.code});
  if (outcome.exitCode !== 0) throw new Error('Workspace capture process failed');
  if (result.value === null) return undefined;
  if (!['absent','oversized','file'].includes(result.value?.kind)) throw new Error('Invalid workspace capture result');
  if (result.value.kind === 'file' && (typeof result.value.file !== 'string' || typeof result.value.binary !== 'boolean'))
    throw new Error('Invalid workspace capture file');
  return result.value;
}
