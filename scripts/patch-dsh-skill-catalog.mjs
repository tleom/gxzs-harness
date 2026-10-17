// The Workbench image pins DSH 0.2.1-alpha.5. Patch its published projection
// until upstream exposes metadata.display-name in SkillSummary and catalog text.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../profiles/workbench/node_modules/@deepseek-ai')
const skill = resolve(root, 'dsh-skill/lib/index.js')
const catalog = resolve(root, 'dsh-tool-skill/lib/index.js')
const packageInfo = JSON.parse(await readFile(resolve(root, 'dsh-skill/package.json'), 'utf8'))
if (packageInfo.version !== '0.2.1-alpha.5') throw new Error('DSH skill version changed; review the catalog patch')

async function replaceExact(path, changes) {
  let source = await readFile(path, 'utf8')
  for (const [before, after] of changes) {
    if (source.includes(after)) continue
    const anchors = (Array.isArray(before) ? before : [before]).filter(value => source.split(value).length === 2)
    if (anchors.length !== 1) throw new Error(`DSH catalog patch anchor changed: ${path}`)
    source = source.replace(anchors[0], after)
  }
  await writeFile(path, source)
}

await replaceExact(skill, [[
  'const { name, description, whenToUse, invocation, source, provider, resourceBase } = skill;\n\treturn {\n\t\tname,',
  'const { name, description, whenToUse, invocation, source, provider, resourceBase } = skill;\n\tconst label = skill.displayName ?? skill.metadata?.["display-name"] ?? skill.metadata?.displayName;\n\tconst displayName = typeof label === "string" && label.trim() && label.length <= 128 ? label.trim() : name;\n\treturn {\n\t\tname,\n\t\tdisplayName,',
]])
await replaceExact(catalog, [
  [
    '\t\tname: skill.name,\n\t\tdescription: catalogDescription(skill.description, descriptionMaxLength)',
    '\t\tname: skill.name,\n\t\tdisplayName: skill.displayName ?? skill.name,\n\t\tdescription: catalogDescription(skill.description, descriptionMaxLength)',
  ],
  [
    'return entries.map((entry) => `- \\`${entry.name}\\`: ${escapeText(entry.description)}`);',
    'return entries.map((entry) => `- \\`${entry.name}\\`${entry.displayName && entry.displayName !== entry.name ? `（${escapeText(entry.displayName)}）` : ""}: ${escapeText(entry.description)}`);',
  ],
  [
    ['JSON.stringify([entry.name, entry.description])', 'JSON.stringify([entry.name, entry.displayName, entry.description])'],
    'JSON.stringify([entry.name, entry.displayName ?? entry.name, entry.description])',
  ],
  [
    'const { name, description } = entry;\n\t\tif (typeof name !== "string" || name === "" || typeof description !== "string") return void 0;\n\t\treadable.push({\n\t\t\tname,\n\t\t\tdescription',
    'const { name, displayName, description } = entry;\n\t\tif (typeof name !== "string" || name === "" || typeof description !== "string") return void 0;\n\t\treadable.push({\n\t\t\tname,\n\t\t\tdisplayName: typeof displayName === "string" && displayName.trim() ? displayName : name,\n\t\t\tdescription',
  ],
])
