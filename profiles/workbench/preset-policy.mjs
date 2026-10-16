export const assistantIdentity = '你是信·法智办案助手，一个 Agent 智能体，使用 {{model}} 模型，协助用户完成办公和办案任务。'

/** Keep the upstream assembly, replacing its persona and built-in web tools. */
export function officePreset(source) {
  return source
    .replace(/^(\s*)- id: tool-web\r?\n[\s\S]*?(?=^\1- id:|$(?![\s\S]))/m, '')
    .replace(/You are a coding agent powered by the \{\{model\}\} model(?:, running on the DeepSeek Harness)?\./g,
      assistantIdentity)
    .replace('You are a helpful software engineer assistant.', assistantIdentity)
}
