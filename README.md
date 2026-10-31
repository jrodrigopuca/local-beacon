# local-beacon

See what a remote [ollama](https://ollama.com) is doing, and talk to it from
outside. Ollama's API tells you which models are loaded, not whether one is
generating, queued or stuck; local-beacon sits on the path between your client
and the server and shows you.

The commands will be `local-beacon` and its shortcut `lbeacon`.

**Status: the core exists, with nothing to run yet.** It is a library inside this
repo, checked with `npm test` and, against a real server, with
`OLLAMA_URL=http://<host>:11434 node scripts/verify-remote.ts`. The CLI comes next,
then the MCP server.

## Planned layers

```
core   ollama client, passive proxy, request states, context-truncation detection
cli    live view and actions, built on the core
mcp    status snapshots and separate action tools, built on the core
```

## Read first

- [`docs/spikes/2026-10-31-observar-ollama.md`](docs/spikes/2026-10-31-observar-ollama.md):
  what can and cannot be observed, measured against a real server.
- [`docs/spikes/2026-10-31-calibrar-truncado.md`](docs/spikes/2026-10-31-calibrar-truncado.md):
  how a prompt cut without notice is detected.
- [`docs/adr/`](docs/adr/): the decisions that shape the repo.

## License

Apache-2.0.
