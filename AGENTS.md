# Working in this repo

Before any decision that is expensive to undo — a layer boundary, what the
proxy may touch, what gets exported — read [`docs/adr/README.md`](docs/adr/README.md).
An accepted ADR is applied and its "Revisar si" line checked, not re-derived
and not overturned in silence; a changed decision gets a new ADR that
supersedes the old one.

Runa is a third-party dependency here ([ADR-0003](docs/adr/0003-runa-como-terceros.md)):
work only from its published docs, `--help`, error messages and observed
behaviour. Do not read its source, even though it sits next to this repo.
