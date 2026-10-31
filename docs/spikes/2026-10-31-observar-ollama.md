# Spike: qué se puede observar de un Ollama remoto

Fecha: 2026-10-31. Servidor: MacBook M2 Pro en la red local, Ollama 0.40.13.
Cliente: M1, Node 26. Modelos: `qwen3.5:4b` (runner `mlx`) y `bonsai-2:9b`
(runner `llamacpp`). Scripts en [`2026-10-31-observar-ollama/`](2026-10-31-observar-ollama/).

Cada caso se corrió una sola vez, con prompts cortos salvo la prueba 5. Son
señales, no estadística. El runner real de `local-sidekicks` no se probó: todo
fue a nivel de API.

## Pregunta

Estamos a ciegas: una corrida larga no deja ver si el modelo genera, espera o
está trabado. ¿Qué se puede saber desde afuera, y desde qué punto?

## Resultados

| # | Prueba | Resultado |
|---|---|---|
| 1 | Streaming por proxy pasivo, `/api/chat` | Mismo texto y 17 fragmentos en ambos casos; primer fragmento 91 ms directo, 102 ms por proxy |
| 1b | Streaming por proxy, `/v1/chat/completions` | HTTP 200, 14 eventos, termina en `[DONE]` |
| 2 | Con y sin streaming | Mismo texto, conteos y claves en la respuesta final |
| 2b | Con y sin streaming, con `format` | Mismo JSON |
| 3 | Cancelar cerrando la conexión | Otro pedido esperó 29,9 s con el modelo ocupado y 64 ms tras cancelar; el proxy registró `client_disconnected` |
| 4 | `/api/ps` durante una generación | Ningún campo cambió entre inactivo y generando |
| 5 | Prompt de 15.970 tokens | Ver abajo |

La primera versión de la prueba 4 no valió: el prompt terminaba en 0,6 s y la
consulta llegó a los 1,5 s. La repetición confirmó 66 líneas recibidas en el
momento de la foto y 297 al final. Después de terminar sí cambiaron `size`,
`size_vram` y `expires_at`, pero eso no permite saber si está ocupado.

## Truncado de contexto

Modelo descargado antes de cada caso. El dato buscado estaba al principio y al
final del prompt.

| Modelo | Runner | `num_ctx` pedido | `context_length` en `/api/ps` | Tokens procesados | Respuesta |
|---|---|---|---|---|---|
| `qwen3.5:4b` | `mlx` | 1024 | 2048 | 15.970 | Correcta |
| `qwen3.5:4b` | `mlx` | por defecto | 16.384 | 15.970 | Correcta |
| `bonsai-2:9b` | `llamacpp` | 1024 | 2048 | 1026 | Perdió el dato y no contestó la pregunta |
| `bonsai-2:9b` | `llamacpp` | por defecto | 16.384 | 15.970 | Correcta |

- `llamacpp` truncó sin error y sin un campo que lo diga. Su `done_reason: length`
  lo causó el límite de 40 tokens de salida, no el truncado.
- `mlx` no aplicó el límite pedido.
- **Corregido:** acá decía que `context_length` no era el límite efectivo. Sí lo
  es. Truncó porque el prompt superó 2048, y lo que deja es la mitad más dos. Ver
  [la calibración](2026-10-31-calibrar-truncado.md).

## Conclusiones

- `/api/ps` sirve para memoria y modelos cargados, no para saber si hay actividad.
- Un proxy pasivo en la máquina cliente distingue caído, inactivo, esperando,
  generando, trabado y fallido. El umbral de "trabado" falta medirlo.
- "En cola" se puede inferir si hay otro pedido en curso, solo cuando todo el
  tráfico pasa por el proxy.
- Detectar truncado exige comparar `prompt_eval_count` con una estimación de
  tokens del cliente. El umbral se midió en
  [la calibración](2026-10-31-calibrar-truncado.md).
- `control.py` en `local-sidekicks` pide `"stream": False`: por el proxy se vería
  "esperando" hasta el final, sin tokens por segundo.

## Pendiente

- Probar streaming en el runner real, detrás de un flag apagado por defecto.
- Revisar si alguna corrida con modelos `llamacpp` superó su contexto. Eso
  afectaría comparaciones entre modelos. `bonsai-2:27b` no se probó.

## Antecedente

`tools/log-proxy.py` en `local-sidekicks` ya muestra los bytes exactos que un host
le manda a Ollama.
