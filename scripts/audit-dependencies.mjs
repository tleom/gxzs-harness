import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const output = resolve(process.argv[2] ?? 'artifacts/dependency-audit')
mkdirSync(output, { recursive: true })
const roots = { profile: 'profiles/workbench', office: 'services/sandbox/office',
  mermaid: 'services/sandbox/office/mermaid', browser: 'services/browser-client' }
const summary = []
for (const [name, cwd] of Object.entries(roots)) {
  const result = spawnSync('npm audit --omit=dev --json', { cwd, shell: true, windowsHide: true,
    encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  let report
  try { report = JSON.parse(result.stdout) } catch { throw new Error(`Dependency audit did not return JSON: ${name}`) }
  if (result.error || ![0, 1].includes(result.status) || report.error || !report.metadata?.vulnerabilities)
    throw new Error(`Dependency audit could not complete: ${name}`)
  writeFileSync(resolve(output, name + '.json'), JSON.stringify(report, null, 2) + '\n')
  const entry = { tree: name, counts: report.metadata.vulnerabilities,
    packages: Object.values(report.vulnerabilities ?? {}).map(item => ({ name: item.name, severity: item.severity,
      advisories: item.via.filter(value => typeof value === 'object').map(value => value.url) })) }
  summary.push(entry)
  console.log(JSON.stringify(entry))
}
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  '## Production npm dependency audit\n\nCounts describe affected package nodes, including transitive parents. Findings are reported; audit execution failures block the job.\n\n'
  + '| Tree | Critical | High | Moderate | Low |\n| --- | ---: | ---: | ---: | ---: |\n'
  + summary.map(({ tree, counts }) => `| ${tree} | ${counts.critical} | ${counts.high} | ${counts.moderate} | ${counts.low} |`).join('\n') + '\n')
