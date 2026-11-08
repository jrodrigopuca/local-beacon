# local-beacon

See what a remote [ollama](https://ollama.com) is doing, and talk to it from
outside. Ollama's API tells you which models are loaded, not whether one is
generating, queued or stuck; local-beacon sits on the path between your client
and the server and shows you.

The commands will be `local-beacon` and its shortcut `lbeacon`.

**Status: usable, not published.** It needs Node 26 and depends on a beta of
[Runa](FRICTION.md). Install it from a local tarball, rebuilt after every change:

```sh
npm pack && npm install -g ./local-beacon-0.0.0.tgz
```

```sh
lbeacon proxy -u http://<host>:11434   # leave it running; OLLAMA_URL also sets -u
lbeacon watch                          # in another terminal
lbeacon status                         # also: requests [--all], cancel <id>
lbeacon --mcp                          # MCP server: status, requests, cancel
```

Point your client at `http://127.0.0.1:11500` instead of ollama, under whatever
name the client reads. Do not use `OLLAMA_URL` for that in the shell that runs
the proxy: to the proxy, that variable is the upstream.

`npm test` checks everything against fake servers. To check against a real one:
`OLLAMA_URL=http://<host>:11434 node scripts/verify-remote.ts`, and the same with
`scripts/verify-cli.ts`.

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
