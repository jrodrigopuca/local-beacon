# ADR-0005: El proxy se controla con HTTP sobre un socket Unix

- Estado: aceptada (2026-10-31)
- Drivers: (1) `watch`, `status` y el MCP corren en otro proceso que el proxy, así
  que hace falta un canal; (2) el canal también acepta `cancel`, y un puerto local
  sin autenticación dejaría que cualquier proceso de la máquina corte una corrida;
  (3) usamos macOS y Linux, sin requisito de Windows.
- Decisión: el proxy expone `GET /status`, `GET /requests` y
  `POST /requests/:id/cancel` en un socket Unix, por defecto
  `~/.local-beacon/control.sock`. El directorio debe pertenecer al usuario y no
  dar permisos a nadie más, o el proxy no arranca. Se reemplaza un socket viejo solo
  si nadie responde en él, y nunca se borra algo que no sea un socket. `watch`
  consulta una vez por segundo, sin streaming de eventos.
- Alternativas: un solo proceso no sirve porque cerrar la vista cortaría el proxy,
  y el MCP corre aparte. Un archivo NDJSON solo permite leer, aunque puede sumarse
  más adelante para guardar historial. Caddy usa un puerto local por compatibilidad
  con Windows, y roborev señala que así la seguridad depende solo del loopback.
- Tradeoff aceptado: no funciona en Windows, hay un archivo de socket que puede
  quedar huérfano, y consultar cada segundo muestra el estado con hasta un segundo
  de atraso. Ese intervalo es criterio propio.
- Revisar si: aparece un requisito de Windows, de una vista remota, o de ver eventos
  con menos de un segundo de atraso.
