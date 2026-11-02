# Feedback para runa-cmd: `0.2.0-beta.3`

**Resultado: los dos bloqueantes de beta.2 están resueltos, y MCP funcionó con un modelo real
en un cliente real.** Lo que queda abierto es menor, salvo una decisión de diseño nueva que
conviene tomar antes de estable: `format()` no recibe las opciones del comando.

Evaluado solo con lo publicado: CHANGELOG, README, `.d.ts`, `--help`, errores y comportamiento.
Node 26.11, npm 12.2, TypeScript 7.0, Zod 4.6.7, macOS.

`local-beacon` usa `core`, `help` y `mcp`. `completions` se evaluó en `notes`.

## 1. Migración

Costó poco. Los dos proyectos quedaron migrados con solo el CHANGELOG y los README.

| Proyecto | Antes de tocar código | Después |
|---|---|---|
| `local-beacon` | `tsc` OK, 121/123 tests | 129/129 tests, 4 de 4 corridas de `verify-cli`, `verify-remote` OK contra Ollama real |
| `notes` | 18/18, pero con la salida duplicada que el harness viejo no veía | 18/18 con `testCLI`, y los dos `todo` de H1 y H2 ahora son tests reales |

**Qué hubo que cambiar en `local-beacon`:** pasar `status`, `requests` y `cancel` a `format`,
borrar la opción `json` y mi función `print`, y separar `cli.ts` de `main.ts` para poder importar
el CLI en tests. Los mensajes del compilador no ayudaron porque el cambio pasaba los tipos: lo
detectaron dos tests por proceso.

**Qué no estaba explicado en lo publicado**

- El CHANGELOG dice que un comando que imprime y devuelve "muestra ambos". Es correcto, pero no
  avisa del efecto colateral en scripts: en `requests`, `--json` pasó de un array a
  `{ "requests": [...] }`, porque ahora imprime lo que devuelve `run()`.
- `testCLI(cli, ...)` necesita importar el CLI sin arrancarlo. Si `main.ts` hace `cli.run()` al
  cargarse, hay que separarlo. El README no lo menciona.
- La sección de beta.3 está repetida igual en los CHANGELOG de los paquetes. Sirve, pero no se
  sabe qué cambio toca a cuál.

## 2. Fricciones

### Resueltas: reproducidas otra vez

| Ref. | Comando | Observado |
|---|---|---|
| H1 | `echo '{"store":"fromcfg"}' > verify.config.json; node verify.ts show` | `{"globalOptions":{"store":"fromcfg"},...}` |
| H1 | `echo '{"store":5}' > verify.config.json; node verify.ts show` | `verify.config.json: invalid value for 'store': ...`, exit 2 |
| H2 | `echo '{"force":true}' > verify.config.json; node verify.ts clear` | `verify.config.json: unknown key 'force'.`, exit 2 |
| H2 | `{"add":{"priority":"high"}}`, luego `node verify.ts list` | `list` no se entera: `{"priority":[]}`, exit 0 |
| H2 | `{"lst":{"limit":1}}`, `notes list` | `unknown key 'lst'. Did you mean 'list'?`, exit 2 |
| H3 | `node verify.ts nth 5` | `number 5`, exit 0 |
| H4, F-09 | `testCLI()` | Ver punto 3 |
| F-01, F-02 | `lbeacon status --json` | `--json` aparece en la ayuda, y no llega como parámetro de la tool |
| F-03 | `commands: { 'list-tags': listTags }`, `notes list-tags` | Funciona. Sin `meta.name` |
| F-04 | `lbeacon status --help` | `USAGE  local-beacon status [options]` |
| F-06 | `tools/call status` con el proxy apagado | Llega mi mensaje textual, con `effect: "unknown"` y sin "may have taken effect" |
| F-10 | `ls node_modules/@runa-cmd/core` | Trae `CHANGELOG.md` |
| F-12, H11 | `run()` sin `output` en `list-tags` | Compila con `tsc` y funciona |
| H7 | `zsh -fc 'autoload -Uz compinit && compinit -D -u; eval "$(notes completions zsh)"'` | Exit 0 y `_notes` queda definida. No apreté TAB en una terminal real |
| H10 | `notes --help \| cat -v`, y con `NO_COLOR=1` | Sin secuencias de escape: 0 coincidencias |
| JSON roto | `{broken` en el config | `Invalid JSON in config file ...`, exit 2 |
| `--bogus` | `notes --bogus` | `Unknown option: --bogus`, exit 2 |

### Siguen abiertas

| Ref. | Comando | Observado |
|---|---|---|
| H6 | `AUDIT=1 node verify.ts tag add`, y `add` | Los dos dan `audit: add`. `MiddlewareContext` sigue sin comando |
| F-05 | `npm view @runa-cmd/core@0.2.0-beta.3 readme` | Vacío en los cuatro paquetes |
| F-07 | `Ctrl+C` a `lbeacon proxy` | `Interrupted.` y exit 130, en un apagado limpio |
| F-08 | `lbeacon proxy` | `Missing required option: --upstream`, sin nombrar `OLLAMA_URL` |
| F-11 | `dist/types.d.ts` | `invocation` está en `HookContext`, no en `RunContext` |
| F-13 | `lbeacon status --help` | `[default: /Users/juan/.local-beacon/control.sock]` |
| F-14 | `LBEACON_SOCKET=... ` y `tools/call status` | `no proxy on [redacted]`. Una ruta no es un secreto |
| H4 | `node verify.ts nope` | `cli.run()` sigue terminando el proceso. `testCLI` cubre los tests, no a quien embebe el CLI |
| Errores | `notes list --limit 0` | `limit: Too small: expected number to be >0`, contra `Invalid value for --limit: expected number` |
| Sugerencias | `notes nada` | `Did you mean 'add'?` |
| Parser | `notes add x -t=a` | Guarda `=a` |
| Completions | `notes completions zsh` | Sigue ofreciendo `--no-help`, `--no-version` o `--no-mcp` |
| MCP | `tools/list` | `completions` se expone como tool por defecto |
| Ayuda | `lbeacon status --help` | `--mcp` y `--version` en las opciones de cada comando |

### Nuevas

**N1 · medio · `format()` no recibe las opciones.** Es la única con decisión de diseño.

```ts
// notes list --no-truncate: la opción cambia cómo se muestra, no qué datos hay.
output: z.object({ notes: ..., total: z.number(), truncate: z.boolean() }),
run: ({ options }) => ({ notes, total, truncate: options.truncate }),
format: ({ notes, truncate }) => ...
```

`truncate` no es un dato, pero tiene que viajar en el resultado, así que también le llega al
modelo y a `--json`. La firma publicada es `(result) => string`. Propuesta:
`format(result, { options, args })`, sin cambiar lo que recibe una tool.

**N2 · bajo · En `notes`, `--limit 0` y un valor inválido en config dicen cosas distintas.** Desde
el archivo el mensaje nombra origen y clave; desde la CLI expone la clave interna.

## 3. `testCLI()`

**Sí sirve, y reemplaza lo que tenía.**

- En `notes` borró 31 líneas de parches a `process.exit`, `console.log` y `stderr`.
- En `local-beacon`, 5 casos corren en 29 ms. Las pruebas por proceso cuestan unos 400 ms cada una.
- **Encontró un error que mi harness escondía:** la salida duplicada de `notes`. El harness viejo no
  capturaba `stdout.write`, y `testCLI` ve lo mismo que el usuario.
- `env` funcionó para aislar `LBEACON_SOCKET`, y dos ejecuciones con `Promise.all` no mezclaron
  salidas.

Sigo probando por proceso lo que necesita señales, sockets y `SIGINT`. No usé `config` en
`testCLI`, ni inspeccioné `trace`.

## 4. Validación con un modelo real

**Cliente y modelo:** `opencode` 2.1.3 con `qwen3.5:9b`, en Ollama 0.40.13 en otra máquina, sin
nombrarle nunca una tool en el prompt. Servidores: `lbeacon --mcp` y `notes --mcp`. Son 24 corridas,
y el material está en `runa-eval/modelo-real/`.

**Forma real del cliente:** `opencode` no expone las tools como funciones. Ofrece un único tool
`execute`, un catálogo en el prompt de sistema, y el modelo escribe JavaScript. `codemode: false`
no cambió eso en mis corridas: las 42 peticiones de esas pruebas tuvieron solo `execute`.

| Pregunta | Resultado |
|---|---|
| **¿Llamó las tools por su cuenta?** | Sí, en 24 de 24 corridas |
| **¿Recibió el resultado completo?** | Sí. En tags, 6 de 6 respuestas correctas con los conteos exactos. En estado, 6 de 6 con la versión correcta. Los conteos de pedidos no los contrasté uno por uno |
| **¿Acepta una tool con guión?** | Sí, en Code Mode: el catálogo la escribe `tools.notes["list-tags"]()`, y el modelo la usó bien en 6 de 6. Dos corridas fallaron primero por un `import` inventado, y se corrigieron solas; no tiene que ver con Runa |
| **Con el proxy apagado, ¿reintentó?** | **Nunca.** 12 de 12 corridas hicieron una sola llamada a la tool que falló |

```sh
# Comando de cada corrida
opencode run --auto --agent probe --format json -m 'ollama/qwen3.5:9b' \
  '¿El servidor de ollama está bien? ¿Qué modelos tiene cargados ahora?'
```

**Qué hizo el modelo después del error**

| Mensaje de error | Culpó a Ollama | Paró y pidió ayuda | Dio la vuelta |
|---|---|---|---|
| Original: `...not running... Start it with: lbeacon proxy` | **5 de 6** | 6 de 6 | 0 |
| Con: `This says nothing about the ollama server, which may be fine.` | 0 de 6 | 4 de 6 | 2 de 6 |

Con el primer mensaje no reintentó, pero sacó una conclusión falsa: Ollama estaba bien. Agregar una
frase lo corrigió, así que el enfoque del README funciona: "say it in your error message". El costo
apareció en las 2 corridas que dieron la vuelta: usaron `fetch` contra `localhost:11434`, que es
**otra máquina**, y respondieron con seguridad sobre el servidor equivocado. El framework no podía
evitarlo: ese `fetch` es del cliente.

`_meta['runa/error']` no llegó al modelo en este cliente: en `execute` solo aparece el texto. Para
un modelo, lo único que cuenta es el mensaje. El README ya lo sugiere; yo lo diría más fuerte.

**Observación del cliente, no de Runa.** Con `--standalone`, el primer pedido sale antes de que
conecten los servidores MCP: el catálogo salió sin tools, y el modelo escribió Python en `execute`
y repitió 16 veces. Con servidores ya conectados, las 9 tools aparecen.

**Por qué 2B no sirvió:** esas corridas fallaron por esa carrera, así que no son evidencia sobre
ese modelo.

## Lo que no se pudo probar

- **Una tool con guión como función del proveedor.** Es la pregunta que más importa para otros
  clientes, y acá no se pudo: `codemode: false` no cambió lo ofrecido. Falta otro cliente.
- **Otro cliente u otro modelo.** Todo es `opencode` con `qwen3.5:9b`. Claude Desktop y MCP
  Inspector, sin probar.
- **`cancel` iniciado por el modelo**, y `readOnlyHint` o `destructiveHint` como permisos reales.
- **H5, H8, H9** y la tabla de contradicciones de documentación: no los repetí.
- **`config` en `testCLI`**, TAB real en zsh, Bash, fish, Linux, Windows, y `output_too_large`.

## Lo que encontré y no era de Runa

Para que no se malinterprete: durante esta evaluación apareció un cuelgue en `verify-cli` que parecía
de `--mcp` con `SIGTERM`. No lo era. Aislado, beta.2 y beta.3 salen en 3 a 4 ms con 143 y 130. La
causa era un bug de `local-beacon`: `watch` no toleraba que el proxy se fuera mientras respondía
(`EPIPE`, `socket hang up`). Ya está corregido.

## Prioridad propuesta

1. **N1, antes de estable:** la firma de `format` se vuelve cara de cambiar.
2. **H6:** `ctx.path` en hooks y middleware. Un plugin de permisos sigue sin distinguir `tag add`
   de `add`.
3. **F-05:** el README en npm, porque es lo primero que ve quien llega.
4. **Validar con otro cliente** la tool con guión expuesta como función.
5. El resto de la lista abierta, cuando convenga.
