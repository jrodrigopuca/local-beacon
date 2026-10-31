# ADR-0001: El núcleo no conoce a Runa ni a MCP

- Estado: aceptada (2026-10-31)
- Drivers: (1) el proyecto existe también para probar Runa como usuario: si la
  lógica de Ollama se mezcla con el CLI, la fricción no se puede atribuir;
  (2) CLI y MCP muestran lo mismo, y duplicar la lógica en dos salidas haría
  que diverjan.
- Decisión: tres capas en orden de construcción. `core` (cliente de Ollama,
  proxy, estados, detección de truncado) no importa Runa ni MCP. `cli` y `mcp`
  son finos y dependen de `core`, nunca entre sí. El núcleo se construye primero,
  con tests contra un servidor falso y una prueba real contra la M2 al cerrar la
  capa.
- Tradeoff aceptado: durante la primera capa no hay producto usable y la prueba de
  Runa se demora. Además, un núcleo sin cliente real puede terminar con una API
  que no sirva; los scripts del spike marcan qué tiene que responder.
- Revisar si: al construir el CLI o el MCP hay que cambiar el núcleo una y otra
  vez porque su API no expresa lo que esas capas necesitan.
