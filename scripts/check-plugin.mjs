for (const name of ['workbench-adapter', 'workbench-mcp-tools', 'tool-discovery']) {
  const plugin = await import(`../packages/${name}/src/index.js`)
  if (plugin.name !== name || typeof plugin.apply !== 'function' || !plugin.Config)
    throw new Error(`${name} exports are incomplete`)
  console.log('plugin-ok:', plugin.name)
}
