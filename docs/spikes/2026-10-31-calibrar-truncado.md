# Spike: calibrar la detección de truncado

Fecha: 2026-10-31. Servidor: MacBook M2 Pro, Ollama 0.40.13. Modelos:
`qwen3.5:4b` y `gemma4:12b` (runner `mlx`), `bonsai-2:9b` (runner `llamacpp`).
Scripts en [`2026-10-31-calibrar-truncado/`](2026-10-31-calibrar-truncado/).

Cada caso se midió una vez. `bonsai-2:27b` no se probó, y ningún prompt de estos
sale de una corrida real de `interaction` o `local-sidekicks`.

## Pregunta

¿Se puede saber que un prompt fue truncado si Ollama no lo informa?

## Caracteres por token

| Texto | Familia Qwen (`qwen3.5:4b`, `bonsai-2:9b`) | `gemma4:12b` |
|---|---|---|
| Código TypeScript | 3,72 | 3,53 |
| Prosa en inglés | 4,62 | 4,65 |
| Prosa en español | 2,91 | 2,94 |
| JSON | 2,31 | 2,32 |
| Líneas con números | 2,92 | 2,92 |

Rango normal: de 2,31 a 4,65. `qwen3.5:4b` y `bonsai-2:9b` dieron los mismos
conteos en todos los textos.

## Caché

`prompt_eval_count` cuenta el prompt completo. Lo que sale de caché va aparte, en
`prompt_eval_cached_count`: al repetir un pedido de 1614 tokens informó 1614 con
1610 en caché. Un segundo turno no parece truncado.

## Punto de corte en `llamacpp`

`context_length` es lo que informa `/api/ps`.

| `num_ctx` pedido | `context_length` | Caracteres | Tokens procesados | Resultado |
|---|---|---|---|---|
| 1024 | 2048 | 5256 | 1793 | Completo |
| 1024 | 2048 | 5840 | 2001 | Completo |
| 1024 | 2048 | 6132 | 1026 | Truncado |
| 1024 | 2048 | 8760 | 1026 | Truncado |
| 1024 | 2048 | 17.520 | 1026 | Truncado |
| 4096 | 4096 | 11.096 | 3916 | Completo |
| 4096 | 4096 | 11.826 | 2050 | Truncado |
| 4096 | 4096 | 12.264 | 2050 | Truncado |
| 4096 | 4096 | 23.360 | 2050 | Truncado |

- El límite es `context_length`, no `num_ctx`. Con 1024 pedidos, el servidor
  informó 2048 y aceptó 2001 tokens. Por qué lo duplicó no se investigó.
- Al truncar quedan exactamente `floor(C / 2) + 2` tokens.
- Un mensaje `system` de 76 caracteres no cambió esa cifra.
- `mlx` no truncó en ningún caso, con prompts de hasta 15.970 tokens y
  `num_ctx: 1024`.

## Qué informa `/v1`

| Pedido | `usage` |
|---|---|
| Sin streaming | Sí |
| Con streaming, por defecto | No |
| Con streaming y `stream_options.include_usage` | Sí |

## Diseño que sale de esto

Dos señales, porque ninguna alcanza sola:

1. **Relación:** más de 6 caracteres por token. Es criterio propio, por encima del
   rango normal, y no necesita datos del modelo. No ve los cortes cercanos al
   límite: truncar deja la mitad, y un JSON a 2,31 da 4,6, igual que una prosa
   normal.
2. **Firma:** los tokens procesados coinciden con `floor(C / 2) + 2`, con tolerancia
   de 2. Requiere que el modelo siga cargado, y no se aplica en `mlx`. Una prueba
   real de ese tamaño exacto daría un falso positivo.

Sin datos de uso, el resultado es `unknown`.

## Límites conocidos

- Las imágenes no cuentan como texto, y las definiciones de tools tampoco. Eso
  subestima el prompt, así que un corte leve podría pasar por la relación.
- Un texto con muchos espacios repetidos podría superar 6 caracteres por token sin
  estar truncado. No se midió.
- Por `/v1` con streaming, sin `include_usage`, no hay detección posible. Falta
  comprobar si opencode lo pide.
- La firma describe el comportamiento de esta versión de Ollama. Otra versión podría
  cambiarla sin aviso.
