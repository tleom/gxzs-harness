import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

function region(source, name) {
  const marker = '//#region ' + name
  if (source.split(marker).length !== 2) throw new Error('Native settings controller region changed: ' + name)
  const start = source.indexOf(marker) + marker.length
  const end = source.indexOf('//#endregion', start)
  if (end < start) throw new Error('Native settings controller region is incomplete: ' + name)
  return source.slice(start, end)
}

/** Reuse exact published pure controllers; renderer and React bodies are not copied. */
export async function nativeSettingsControllers(profile) {
  const require = createRequire(join(resolve(profile), 'package.json'))
  const read = async (name, entry) => {
    const manifest = JSON.parse(await readFile(require.resolve(name + '/package.json'), 'utf8'))
    if (manifest.version !== '0.2.1-alpha.5') throw new Error('Unverified native settings version: ' + manifest.version)
    return readFile(require.resolve(entry ?? name + '/client'), 'utf8')
  }
  const [forms, primitives, card, conversation, schedule] = await Promise.all([
    read('@deepseek-ai/dsh-client-ui-settings'),
    read('@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-primitives'),
    read('@deepseek-ai/dsh-client-ui-settings-subagent'),
    read('@deepseek-ai/dsh-client-ui-conversation'),
    read('@deepseek-ai/dsh-client-ui-schedule'),
  ])
  const start = forms.indexOf('factory: (require) => {')
  const end = forms.lastIndexOf('return module.exports;')
  if (start < 0 || end <= start || !forms.includes('var ConfigForms = class') || !forms.includes('var SettingsDescribeMirror = class'))
    throw new Error('Native settings factory contract changed')
  const body = forms.slice(start + 'factory: (require) => {'.length, end)
  const settings = region(conversation, 'lib/types/submission-settings.js')
  const literal = name => {
    const matches = [...settings.matchAll(new RegExp('const ' + name + ' = ("[^"\\n]*");', 'g'))]
    if (matches.length !== 1) throw new Error('Native submission setting changed: ' + name)
    return matches[0][1]
  }
  const header = region(conversation, 'lib/types/client/skeleton/ConversationSession.js')
  const ancestryStart = header.indexOf('function deriveAncestry(')
  const ancestryEnd = header.indexOf('function equalBreadcrumbs(', ancestryStart)
  if (ancestryStart < 0 || ancestryEnd <= ancestryStart || !header.slice(ancestryStart, ancestryEnd).trimEnd().endsWith('}'))
    throw new Error('Native ancestry presenter contract changed')
  return `
import * as Cordis from '@deepseek-ai/cordis';
import * as Store from '@deepseek-ai/dsh-client-store';
const require = id => {
  if (id === '@deepseek-ai/cordis') return Cordis;
  if (id === '@deepseek-ai/dsh-client-store') return Store;
  throw new Error('Unadmitted native settings dependency: ' + id);
};
function nativeSettingsDomain() {
${body}
return { ConfigForms, SettingsSchemaService, SettingsDescribeMirror };
}
const { ConfigForms, SettingsSchemaService, SettingsDescribeMirror } = nativeSettingsDomain();
const _deepseek_ai_dsh_client_store = Store;
const createSnapshotStore = Store.createSnapshotStore;
${region(primitives, 'lib/types/settings-form/form-model.js')}
const _deepseek_ai_dsh_client_ui_primitives = { SettingsFormModel, settingsNumberField };
${region(card, 'lib/types/client/subagent-limits-card-controller.js')}
${region(card, 'lib/types/client/subagent-model-selection-card-controller.js')}
${region(card, 'lib/types/client/subagent-card-controller.js')}
const BUSY_ENTER_FIELD = ${literal('BUSY_ENTER_FIELD')};
const DEFAULT_BUSY_ENTER_BEHAVIOR = ${literal('DEFAULT_BUSY_ENTER_BEHAVIOR')};
${region(conversation, 'lib/types/client/input/submission-policy.js')}
${header.slice(ancestryStart, ancestryEnd)}
${region(schedule, 'lib/types/client/catalog-source.js')}
export { ConfigForms, SettingsSchemaService, SettingsDescribeMirror, SubagentLimitsCardController,
  SubagentModelSelectionCardController, subagentCardFace, subagentCardShell, ComposerSubmissionPolicy, resolveSubmitMode, deriveAncestry, createCatalogSource };
export const nativeSettingsProvenance = ${JSON.stringify({
  version: '0.2.1-alpha.5',
    sources: Object.fromEntries([['dsh-client-ui-settings/client', forms], ['dsh-client-ui-primitives', primitives],
      ['dsh-client-ui-settings-subagent/client', card], ['dsh-client-ui-conversation/client', conversation], ['dsh-client-ui-schedule/client', schedule]].map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')])),
    regions: ['settings-form/form-model', 'subagent-limits-card-controller', 'subagent-model-selection-card-controller', 'subagent-card-controller', 'submission-policy', 'ConversationSession.deriveAncestry', 'schedule/catalog-source'],
})};
`
}
