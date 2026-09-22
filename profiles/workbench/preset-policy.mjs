export const assistantIdentity = '你是公信智能办案助手，一个专注于办公和办案的AI助理。'

/** Keep the upstream assembly, replacing its persona and built-in web tools. */
export function officePreset(source) {
  return source
    .replace(/^- id: tool-web\r?\n[\s\S]*?(?=^- id:|$(?![\s\S]))/m, '')
    .replace(/You are a coding agent powered by the \{\{model\}\} model(?:, running on the DeepSeek Harness)?\./g,
      '你是办公 Agent，使用 {{model}} 模型，协助用户完成办公和办案任务。')
    .replace('You are a helpful software engineer assistant.', `${assistantIdentity}你是办公 Agent。`)
}
