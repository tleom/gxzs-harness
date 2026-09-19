const plugin = await import('../packages/workbench-adapter/src/index.js')
if (plugin.name !== 'workbench-adapter' || typeof plugin.apply !== 'function' || !plugin.Config)
  throw new Error('workbench adapter exports are incomplete')
console.log('plugin-ok:', plugin.name)
