/** Append the published database text through DSH's native assembly hook. */
export function registerDatabasePrompt(ctx, ownerId) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    // Fetch per assembly: the first turn and subsequent turns see the published
    // value, including disabling it. Failure must not silently drop instructions.
    const payload = await ctx.workbenchPlatformClient.json({
      owner: { ownerId }, method: 'GET', route: 'workbench/config',
      signal: context.signal, timeoutMs: 5000,
    })
    const config = payload?.data
    if (!config || typeof config.enabled !== 'boolean')
      throw new Error('平台提示词配置无效')
    if (!config.enabled) return assembly
    if (typeof config.system_prompt !== 'string')
      throw new Error('平台提示词必须是文本')
    if (!config.system_prompt.trim()) return assembly
    return {
      ...assembly,
      sections: [...assembly.sections, {
        name: 'gxzs:database-prompt', text: config.system_prompt,
        // Database content is literal text, not a DSH template.
        interpolate: false,
      }],
    }
    // DSH still enforces complete:true after this hook, as for every provider.
  }, { global: true })
}
