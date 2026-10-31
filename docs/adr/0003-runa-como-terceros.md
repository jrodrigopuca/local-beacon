# ADR-0003: Runa se evalúa como dependencia de terceros

- Estado: aceptada (2026-10-31)
- Drivers: (1) el CLI y el MCP se construyen también para descubrir cómo mejorar
  Runa; (2) quien conoce el código explica la fricción en vez de sentirla, y ese
  sesgo es lo que esta prueba quiere evitar.
- Decisión: durante el proyecto se trabaja solo con lo que ve un usuario nuevo:
  documentación publicada, `--help`, mensajes de error y comportamiento observado.
  No se lee el código de Runa. La fricción se registra en `FRICTION.md` (qué se
  intentó, qué se esperaba, qué pasó, qué rodeo se usó, cuánto molestó) y no se
  arregla en Runa durante la prueba. La salida MCP arranca por `@runa-cmd/mcp`,
  que es lo primero que probaría un usuario; un servidor escrito a mano queda como
  alternativa, y necesitarlo ya es un hallazgo.
- Tradeoff aceptado: se tarda más en resolver problemas que el autor entendería
  al instante, y algún rodeo puede resultar innecesario.
- Revisar si: el autor levanta la restricción, por ejemplo para pasar de registrar
  fricción a corregirla en Runa.
