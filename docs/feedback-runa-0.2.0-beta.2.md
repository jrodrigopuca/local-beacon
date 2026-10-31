# Feedback para runa-cmd: `0.2.0-beta.2`

**Recomendación: una beta más antes de estable.** El framework está muy bien, y
`@runa-cmd/mcp` es lo mejor del conjunto. Lo que frena el pase es el archivo de
configuración: da resultados incorrectos sin avisar, y su formato es un contrato que se
vuelve caro de cambiar una vez publicado.

Dos evaluaciones de usuario nuevo, sin leer el código de Runa, con Node 26.11, npm 12.2,
TypeScript 7.0 y Zod 4.6 en macOS:

- **`local-beacon`:** CLI y MCP reales sobre un Ollama remoto. Detalle en
  [`FRICTION.md`](../FRICTION.md), con las referencias `F-nn`.
- **`notes`:** CLI hecho para esta evaluación por otro agente, sin conocer los resultados
  anteriores. Cubre configuración, comandos anidados, middleware, plugins, help,
  completions, tests y empaquetado. Referencias `H-nn`.

Confirmación: **ambas** significa que el hallazgo salió por separado o que se reprodujo de
forma independiente; **una** significa que se observó solo en esa evaluación.

## Bloquean estable

### 1. Las opciones globales ignoran el archivo de configuración (H1)

Confirmación: ambas.

El README promete `CLI > env > config > defaults`, sin excepciones. Con globales, el
config se ignora en silencio, incluso con un tipo inválido. Quien configure un `store`
termina escribiendo en otro archivo sin enterarse.

```ts
const cli = defineCLI({
  meta: { name: 'verify' },
  commands: { show, clear, list, add },
  globalOptions: { store: z.string().default('dflt') },
  config: { name: 'verify', searchPaths: ['.'] },
});
```

```
$ echo '{"store":"fromcfg"}' > verify.config.json
$ node verify.ts show
{"globalOptions":{"store":"dflt"},...}      # esperado: fromcfg, exit 0

$ echo '{"store":5}' > verify.config.json
$ node verify.ts show
{"globalOptions":{"store":"dflt"},...}      # esperado: error de validación, exit 0
```

Una opción de comando sí lee el config. El rodeo posible es malo: en un hook `beforeRun`,
`rawArgs` ya no trae las flags globales, así que no se distingue un valor de CLI.

### 2. El config es un único espacio plano entre comandos (H2)

Confirmación: ambas.

Una clave se aplica a toda opción con ese nombre, en cualquier comando, y no existe forma de
dar un valor a un solo comando. `{"clear":{...}}` y `{"commands":{"clear":{...}}}` se ignoran
sin aviso. El README no documenta la forma del archivo.

```
$ echo '{"force":true}' > verify.config.json
$ node verify.ts clear
DELETED                                     # un guardarraíl apagado desde un archivo

$ echo '{"priority":"high"}' > verify.config.json
$ node verify.ts add
{"priority":"high"}
$ node verify.ts list                       # en list, priority es un array
Invalid value for --priority: expected array
Run 'verify --help' for usage.              # exit 2, y nunca se escribió --priority
```

En `notes`, un `tag` pensado para `add` convirtió a `list` en un filtro: salida vacía y
exit 0. Los errores deberían nombrar la fuente, como `verify.config.json: "priority"`.

## Conviene resolver antes de estable

| Ref. | Confirmación | Problema | Rodeo |
|---|---|---|---|
| H3 | Ambas | `args: { id: z.number() }` falla por CLI con `expected number, received string`, y funciona por MCP. El tipo dice `number`, así que TypeScript no avisa | `z.coerce.number()` |
| H4, F-09 | Ambas | Sin historia de testing. `cli.run()` llama a `process.exit` ante un error y mata el runner, devuelve `undefined`, y no se pueden inyectar stdout, stderr ni exit | Parchear globales, o probar por subproceso |
| F-12, H11 | Ambas | El README de `mcp` documenta devolver un string u objeto sin `output`, y los tipos lo rechazan con `TS2322`. En ejecución funciona | Declarar `output` |
| F-01, F-02 | Ambas | Lo que devuelve `run()` no se ve en la terminal, y no hay `--json` estándar. Cada comando imprime además de devolver, y la opción `json` queda expuesta como parámetro de la tool | Imprimir y devolver |
| H6 | Ambas | `ctx.command.name` es solo la hoja: `tag add` y `add` dan `add` en hooks. El middleware no recibe el comando. Un plugin de permisos o auditoría falla sin que se note | Sin rodeo limpio; se propone `ctx.path` |
| F-06 | Ambas | Un `CommandError` esperado dice "may have taken effect" y `safeToRetry: false`, también con `readOnlyHint: true` | Ninguno |
| F-03 | Una | `meta.name` es obligatorio pero no define el comando. `with-output` da 127 y sugiere `withOutput` | Comandos de una palabra |
| F-05 | Una | El README no está en el registro de npm, en ningún paquete ni versión | `npm pack` |
| H5 | Una | El ejemplo de Layer 3 de help no compila en TS estricto; con un cast, crashea en un CLI de un solo comando; y `styled(x, { color: theme.primary })` pierde el color | `defaultRenderer` y hex directo |
| H7 | Una | `eval "$(notes completions zsh)"`, sugerido por `--instructions`, da error en cada shell y deja TAB sin completar | Instalar por `fpath` |
| H8 | Una | Un `]` en una descripción deja a todo el comando sin completado en zsh, y un enum con espacio se parte en dos. El README promete valores escapados | Evitar esos caracteres |
| H9 | Una | Por MCP, una opción con `env` sale del schema, y si el modelo la envía se descarta con éxito. Está documentado, pero un config en el directorio cambia el schema, y una clave desconocida sí da error | `expose` |
| H10 | Una | El `--help` del plugin emite bold y dim hacia un pipe y con `NO_COLOR=1`. `theme.secondary` no cambia el render por defecto | Ninguno |

## Documentación

**Contradicciones**

| Dice | Pasa |
|---|---|
| README de help: un `-h` propio da `OPTION_COLLISION` | El comando conserva `-h`, como dice core |
| README de help: `db migrate --help` muestra la ayuda de `db` | Muestra la del comando anidado, como dice core |
| README de core: `rawArgs` es "Original argv" | En hooks viene sin las flags globales |

**Falta explicar:** variádicos con `z.array()` en `args`, la forma del archivo de config,
`ctx.invocation`, testing, y un registro de cambios dentro del paquete (`hint` pasó a
`valueName`). Los README solo muestran `pnpm`.

**Duda abierta:** `RunContext` no documenta `invocation`. ¿Un comando puede saber si corre
por MCP?

## Menores

**Ayuda**

- `USAGE` omite el nombre del CLI y el `...` de un variádico (F-04, H).
- Un grupo no puede tener descripción.
- Un booleano con default `true` no muestra `--no-truncate`.
- Un array vacío muestra `[default: ]`.
- `group: 'Flags'` se muestra como `FLAGS OPTIONS`.
- `--mcp` y `--version` aparecen en las opciones de cada comando.
- El tipo de un variádico se muestra como `array`.
- Un default calculado muestra una ruta personal completa (F-13).

**Errores**

- Conviven `Invalid value for --limit: expected number` y `limit: Too small: expected
  number to be >0`, que expone Zod y la clave interna.
- Un JSON roto en el config sale como `Unexpected error`, cuando es un error del usuario.
- `notes --bogus` da `Command not found` y 127; debería ser `Unknown option` y 2.
- `nada` sugiere `add`: la distancia de sugerencia es generosa.
- Falta mencionar la variable de entorno al faltar una opción (F-08).
- `-t=a` guarda `=a`.

**Completions**

- Ofrece `--no-help`, `--no-version` y `--no-mcp`.
- Los posicionales enum no se completan.

**MCP**

- `completions` se expone como tool por defecto.
- `exclude` no acepta un grupo, y su error no lista los nombres válidos.
- La redacción oculta rutas que no son secretas: `no proxy on [redacted]` (F-14).

**Otros**

- Un servicio que termina bien imprime `Interrupted.` y sale con 130 (F-07).
- Un middleware que no llama a `next()` cancela el comando sin aviso; conviene documentarlo.
- La ruta de Claude Desktop del README de `mcp` podría no ser la de macOS. No se verificó.

## Qué funcionó bien: no tocar

- **Tipos:** inferencia en TS estricto, `meta.options` con sugerencias, y `output` exigiendo
  el retorno correcto.
- **Parser:** anidados, variádicos, `--`, `--no-x`, `--flag=valor`, negativos, globales antes
  o después del comando, repetidas y enums.
- **Prioridad en opciones de comando:** `CLI > env > config > default`.
- **Mensajes y salidas:** sugerencias, códigos 2 y 127, y `CommandError` con su código.
- **Ciclo de vida:** hooks en orden, `cleanup` también ante errores, y capabilities con un
  mensaje excelente.
- **Señales:** `ctx.signal`, 130 y 143, y el límite de 2 s para un comando que no responde.
- **MCP:** `exclude` como límite real, `structuredContent`, `effect` y `safeToRetry`,
  aislamiento de `process.exit`, cancelación, recorte de salida, y un stdout limpio.
- **Empaquetado:** `npm pack`, instalación global y `--mcp` desde otro directorio, sin
  `selfCommand`.
- **Completions por `fpath` en zsh:** comandos, anidados, enums y alias.

## Prioridad propuesta

1. **Modelo de config:** cubrir globales, definir un lugar por comando, documentar la forma y
   nombrar la fuente en los errores. Es lo único de esta lista que se encarece mucho después
   de estable.
2. **Contrato de testing:** `run()` sin matar el proceso, o un `testCLI()` que devuelva
   `{ code, stdout, stderr, result }`.
3. **Salida por superficie:** resolver juntos F-01, F-02 y F-12, porque definen cómo se
   escribe cada comando.
4. **Conversión de posicionales:** el mismo schema tiene que comportarse igual en opciones,
   argumentos y MCP.
5. **`ctx.path` en hooks y middleware.**

## Lo que no se probó

Bash y fish interactivos, Linux, Windows, MCP Inspector, Claude Desktop, `serverOnly`,
`output_too_large`, tool calls concurrentes, binario compilado, loaders propios, plugins lazy,
migración desde `0.1.0`, y Ctrl+C en una terminal real. La evaluación se hizo solo sobre macOS.
