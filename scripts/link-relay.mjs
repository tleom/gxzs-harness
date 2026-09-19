import net from 'node:net'

const listenHost = process.env.GXZS_RELAY_HOST ?? '0.0.0.0'
const listenPort = Number(process.env.GXZS_RELAY_PORT ?? 3081)
const targetHost = process.env.GXZS_RELAY_TARGET_HOST ?? '127.0.0.1'
const targetPort = Number(process.env.GXZS_RELAY_TARGET_PORT ?? 3080)
if (![listenPort, targetPort].every((value) => Number.isInteger(value) && value > 0 && value < 65536)) throw new Error('invalid relay port')
const server = net.createServer((source) => {
  const target = net.connect({ host: targetHost, port: targetPort })
  source.pipe(target).pipe(source)
  const close = () => { source.destroy(); target.destroy() }
  source.on('error', close); target.on('error', close)
})
server.listen(listenPort, listenHost)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
