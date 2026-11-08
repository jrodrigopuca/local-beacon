# Fricción con Runa

Registro de lo que encuentra un usuario nuevo, según el
[ADR-0003](docs/adr/0003-runa-como-terceros.md): fuentes públicas y comportamiento
observado, sin leer el código. Versión evaluada: `0.2.0-beta.2`, con Node 26 y npm 12; seguimiento hasta `0.2.0-beta.5`.
Los resultados de `0.1.0` no cuentan.

**Estado en `0.2.0-beta.3`:** F-01, F-02, F-03, F-04, F-06, F-09, F-10 y F-12 quedaron
resueltas. F-05, F-07, F-08, F-11, F-13 y F-14 siguen abiertas. Detalle en
[`docs/feedback-runa-0.2.0-beta.3.md`](docs/feedback-runa-0.2.0-beta.3.md). Las entradas de
abajo describen lo observado en beta.2.

**Estado en `0.2.0-beta.5`:** la actualización no pidió cambios de código. F-08 y F-13
quedaron resueltas: el error nombra `OLLAMA_URL` y `defaultDescription` oculta el home.
F-14 se cerró sin cambios, porque en 12 corridas con un modelo real la redacción no cambió
el comportamiento. F-11 se cerró por decisión de runa-cmd, ya que `format` cubre el caso.
Siguen abiertas F-05, que se comprueba al publicar la 1.0, y F-07, que es lo próximo de
runa-cmd y tiene una medición en launchd en su entrada.

**Estado en `0.2.0-beta.6`:** F-07 quedó resuelta. Al actualizar hubo que cambiar dos tests y
un script que leían `code === 130` de un `spawn`: ahora llega `code: null` y
`signal: 'SIGINT'`. Lo había anunciado runa-cmd. Sigue abierta F-05.

Nivel: **alto** condiciona el diseño, **medio** obliga a un rodeo, **bajo** es una
molestia. El código de la prueba está en cada entrada cuando hace falta.

## Abiertos

### F-01 · alto · Lo que `run()` devuelve no se ve en la terminal

- **Intenté:** comandos que devuelven un objeto, con y sin `output`, y uno que
  devuelve un string.
- **Esperaba:** que el valor se mostrara o que el README dijera que no.
- **Pasó:** stdout vacío y salida 0 en los tres casos. Por MCP el mismo comando sí
  responde. El README describe solo el lado MCP.
- **Rodeo:** imprimir para personas y además devolver el valor. Funciona porque "a
  returned value wins over what the command printed". El formato queda dentro de
  `run()`, y también corre, sin utilidad, en cada llamada MCP.
- **Duda:** ¿es la forma recomendada de servir a personas y agentes con un comando?

### F-12 · alto · Los tipos prohíben lo que el README de `mcp` documenta

- **Intenté:** devolver un objeto desde `run()` sin `output`, como indica la fila
  "Command returns an object (no output schema)" del README de `mcp`.
- **Esperaba:** que compilara.
- **Pasó:** `TS2322`: sin `output`, `run` debe devolver `void | Promise<void>`. En
  ejecución funciona, porque Node no verifica tipos, así que el error aparece solo en
  quien corre `tsc`.
- **Rodeo:** declarar `output`, con el costo de escribir un esquema Zod por comando.
- **Duda:** ¿se corrige el tipo o el README? Dos filas de esa tabla dependen de esto.

### F-02 · medio · No hay una forma estándar de `--json`

- **Intenté:** ver si existía una salida por máquina.
- **Pasó:** cada comando tiene que declarar su opción `json` y resolverla, y esa opción
  aparece como parámetro de la tool, donde no significa nada.
- **Rodeo:** una opción propia en cada comando, y `exclude` no sirve porque quitaría la
  tool entera. Confirmado en `local-beacon`: la tool `status` expone `json` al modelo.
  `ToolOptions` no documenta cómo ocultar una opción sin declararle `env`.

### F-03 · medio · `meta.name` no define el nombre del comando

- **Intenté:** `meta: { name: 'with-output' }` registrado como `commands: { withOutput }`.
- **Esperaba:** ejecutarlo como `with-output`, igual que `darkColor` pasa a `--dark-color`.
- **Pasó:** `with-output` da 127 y sugiere `withOutput`. La ayuda también muestra la
  clave. `meta.name` es obligatorio pero no se ve en ningún lado.
- **Rodeo:** comandos de una sola palabra. Este proyecto no lo sufre todavía.
- **Duda:** ¿qué hace `meta.name` dentro de `defineCLI`? ¿Una clave `'with-output'` es
  la forma prevista?

### F-04 · medio · La ayuda de un subcomando omite el nombre del CLI

- **Intenté:** `local-beacon envOption --help`.
- **Pasó:** muestra `USAGE  envOption [options]`, que no es un comando que se pueda
  ejecutar. Debería decir `local-beacon envOption [options]`.
- **Rodeo:** ninguno.

### F-05 · medio · El README no llega a la página de npm

- **Intenté:** leer la documentación con `npm view` y en el registro.
- **Pasó:** los paquetes traen `README.md`, pero el campo `readme` del registro está
  vacío en `core`, `help`, `mcp` y `completions`, en `0.1.0` y en la beta. La página de
  npm probablemente aparece sin documentación. No la abrí en un navegador.
- **Rodeo:** `npm pack` y extraer el README.

### F-06 · medio · Un fallo esperado se le presenta al modelo como posible efecto

- **Intenté:** por MCP, un comando que lanza `CommandError` al empezar.
- **Pasó:** `effect: "unknown"`, `safeToRetry: false` y el texto "The command started, so
  it may have taken effect. Check before retrying.".
- **Molestia:** es correcto en general, pero le sugiere al modelo un riesgo que no
  existe. Confirmado en `local-beacon`: `status` declara `readOnlyHint: true` y, con el
  proxy apagado, igual responde "may have taken effect" y `safeToRetry: false`. Un
  `cancel` de un id desconocido responde lo mismo.
- **Duda:** ¿hay forma de declarar que un fallo no tuvo efectos? ¿Debería un comando
  de solo lectura ser siempre seguro de reintentar?

### F-07 · bajo · Un servicio que termina bien sale como interrumpido

- **Intenté:** un comando largo que sigue `ctx.signal` y termina limpio.
- **Pasó:** imprime `Interrupted.` en stderr y sale con 130, aunque el comando terminó
  ordenadamente. La salida está documentada; el mensaje, no.
- **Duda:** en un servicio, Ctrl+C es la forma normal de pararlo. ¿Se puede evitar
  `Interrupted.`?
- **En launchd (beta.5, macOS 27.0.1):** probé `lbeacon proxy` como LaunchAgent, parado
  con `launchctl kill`.
  - **Sin `KeepAlive`:** registra `last exit code = 143` ante SIGTERM y `130` ante SIGINT,
    escribe `Interrupted.` en el log de stderr, y no reinicia.
  - **Con `KeepAlive` → `SuccessfulExit: false`,** la opción para "reiniciar solo si falla":
    una parada limpia por SIGTERM **se reinicia**, porque 143 no es éxito. Un proceso de
    control que sale con 0 ante la misma señal no se reinicia.
  - **En los dos casos:** `cleanup` borró el socket.

  Con esa opción, entonces, un servicio de Runa no se puede parar desde afuera sin que
  launchd lo vuelva a levantar. systemd no lo probé, porque no tengo Linux.
- **Resuelta en beta.6.** Repetí la prueba con los mismos casos:
  - **Sin `KeepAlive`:** launchd registra `last terminating signal = Terminated: 15`, o
    `Interrupt: 2` ante SIGINT, en lugar de un exit code. El log de stderr queda vacío.
  - **Con `SuccessfulExit: false` y `launchctl kill`:** lo sigue reiniciando, porque launchd
    reinicia cualquier proceso que no sale con 0. No depende de Runa.
  - **La forma de pararlo:** `launchctl bootout` descarga el agente, no lo reinicia, corre
    `cleanup` y no escribe nada en stderr.
  - **En la shell:** `$?` sigue siendo 143.

### F-08 · bajo · El error por opción faltante no menciona su variable de entorno

- **Intenté:** `envOption` sin `--upstream`, con `env: 'OLLAMA_URL'` declarado.
- **Pasó:** `Missing required option: --upstream`. Una persona no se entera de que
  también podía usar `OLLAMA_URL`, salvo que lea la ayuda.

### F-09 · bajo · No hay guía para probar comandos

- **Intenté:** encontrar en el README cómo testear un comando.
- **Pasó:** no hay sección. `runCLI` acepta `argv`, y no queda claro si `cli.run()`
  también, ni cómo capturar la salida y el código de salida.
- **Rodeo:** mantener la lógica fuera de `run()`, en el núcleo, y probar el CLI como
  proceso real.

### F-10 · bajo · No hay registro de cambios en los paquetes

- **Intenté:** ver qué cambió entre `0.1.0` y la beta.
- **Pasó:** no hay `CHANGELOG` dentro del paquete, y `hint` pasó a `valueName`. Lo noté
  comparando los README.

### F-11 · bajo · Duda sobre `ctx.invocation.surface`

- El README de `mcp` lo menciona para hooks. `RunContext` no lo incluye. ¿Un comando
  puede saber si corre por MCP para no gastar en formatear?

### F-13 · bajo · Un valor por defecto calculado se muestra tal cual en la ayuda

- **Intenté:** `.default(defaultSocketPath())`, una ruta dentro del home.
- **Pasó:** `--help` muestra `[default: /Users/juan/.local-beacon/control.sock]`. Un
  texto de ayuda copiado expone la ruta personal y no refleja lo que verá otro usuario.
- **Duda:** ¿hay forma de mostrar un valor legible, como `~/.local-beacon/control.sock`?

### F-14 · bajo · La redacción quita datos que el modelo necesita

- **Intenté:** por MCP, `status` con el proxy apagado y el socket en `LBEACON_SOCKET`.
- **Pasó:** el mensaje llega como `no proxy on [redacted]`. Es lo que documenta el
  README para valores fijos de 8 caracteres o más, pero una ruta no es un secreto.
- **Duda:** ¿se puede marcar una variable de entorno como no secreta?

## Lo que funcionó como dice el README

- `--version`, `--help` y `-h` sin configurar nada; sin comando, ayuda a stderr y salida 2.
- Código 127 con sugerencia, y 2 en errores de uso con `Run '... --help'`.
- `CommandError` con su código de salida.
- `ctx.signal`: Ctrl+C aborta, corre `cleanup` y sale con 130. Un comando que ignora la
  señal se dejó de esperar a los 2,0 s.
- `exclude`: la tool no aparece y llamarla da `unknown_tool`.
- `annotations` llegan al cliente, y una opción con `env` queda fuera del esquema.
- Cada llamada MCP corre en un proceso propio, lo que encaja con el canal por socket
  del [ADR-0005](docs/adr/0005-canal-por-socket-unix.md). Costó unos 200 ms por llamada
  en una M1 con TypeScript sin compilar.
- `output` llega como `structuredContent` y `z.url()` rechaza un valor inválido con
  salida 2, sin código adicional.
- El CLI y el MCP funcionaron sobre una generación real en Ollama: `proxy`, `watch`,
  `status`, `requests` y `cancel`.
