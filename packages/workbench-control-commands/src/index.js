export const name = 'workbench-control-commands'
export const inject = ['commands']

export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: 'todos-clear',
    description: 'Clear the current session todo list.',
    recordInput: false,
    handler: ({ agent }) => {
      agent.session.append('todo/write', { todos: [] })
      return { kind: 'success', text: '任务列表已清空' }
    },
  }), 'gxzs todos clear command')
}
