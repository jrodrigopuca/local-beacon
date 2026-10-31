# Decisiones (ADR)

Una decisión por archivo, numeradas en el orden en que se pensaron. Un ADR
aceptado no se edita: si la decisión cambia, uno nuevo lo reemplaza y el viejo
pasa a `superseded`.

| # | Decisión | Estado |
|---|---|---|
| [0001](0001-capas.md) | El núcleo no conoce a Runa ni a MCP | aceptada |
| [0002](0002-proxy-pasivo.md) | El proxy observa y no altera | aceptada |
| [0003](0003-runa-como-terceros.md) | Runa se evalúa como dependencia de terceros | aceptada |
| [0004](0004-un-paquete-privado.md) | Un solo paquete, sin publicar por ahora | aceptada |

## Pendientes

Todavía no son decisiones. Cada una dice qué la abriría.

- **Notas durante una corrida.** Dejar información para que el modelo la reciba
  en el próximo turno, sin cortar el pedido en curso. No hace falta para las
  pruebas actuales. Dos cosas ya quedan previstas: los pedidos llevan un id de
  corrida para poder dirigir la nota, y la entrega la hace el cliente o el
  runner, nunca el proxy, e informa si la corrida terminó antes de entregarla.
  Se abre cuando una corrida real necesite ese dato a mitad de camino.
- **Agente en la máquina remota.** El proxy ve un corte de conexión, no su causa;
  memoria, swap, logs y reinicio requieren un proceso allá. Se abre cuando un
  fallo real no se pueda explicar desde el proxy.
