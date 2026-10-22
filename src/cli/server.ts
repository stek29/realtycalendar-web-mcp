// Hosted HTTP server entrypoint (the Docker image's command): node dist/server.js
import { runHttp } from '../platforms/node.js'

await runHttp()
