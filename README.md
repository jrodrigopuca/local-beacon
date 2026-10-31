# local-beacon

See what a remote [ollama](https://ollama.com) is doing, and talk to it from
outside. Ollama's API tells you which models are loaded, not whether one is
generating, queued or stuck; local-beacon sits on the path between your client
and the server and shows you.

The commands will be `local-beacon` and its shortcut `lbeacon`.

**Status: nothing to run yet.** The repo holds the spike that justifies the
design and the decisions taken from it. The core comes first, then the CLI,
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
- [`docs/adr/`](docs/adr/): the decisions that shape the repo.

## License

Apache-2.0.
