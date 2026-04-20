-- ─────────────────────────────────────────────
-- schema.sql — Esquema de Base de Datos
-- Motor: PostgreSQL 14+
-- Ejecutar: psql -U postgres -d asistente_db -f schema.sql
-- ─────────────────────────────────────────────


-- ── TABLA: estudiantes ────────────────────────
-- Un registro por cada estudiante registrado
CREATE TABLE IF NOT EXISTS estudiantes (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(120) NOT NULL,
  email       VARCHAR(200) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,         -- hash bcrypt
  activo      BOOLEAN      DEFAULT TRUE,
  created_at  TIMESTAMP    DEFAULT NOW()
);


-- ── TABLA: sesiones ───────────────────────────
-- Una sesión = una visita continua al asistente
-- Si el estudiante deja pasar 30 min, se abre sesión nueva
CREATE TABLE IF NOT EXISTS sesiones (
  id             SERIAL PRIMARY KEY,
  estudiante_id  INT          NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
  created_at     TIMESTAMP    DEFAULT NOW(),
  updated_at     TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sesiones_estudiante ON sesiones(estudiante_id);
CREATE INDEX IF NOT EXISTS idx_sesiones_updated    ON sesiones(updated_at);


-- ── TABLA: interacciones ──────────────────────
-- El corazón del sistema: cada pregunta/evaluación queda aquí
CREATE TABLE IF NOT EXISTS interacciones (
  id               SERIAL PRIMARY KEY,
  sesion_id        INT           REFERENCES sesiones(id) ON DELETE SET NULL,
  estudiante_id    INT           NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,

  -- Contenido del intercambio
  mensaje_usuario  TEXT          NOT NULL,
  respuesta_ia     TEXT          NOT NULL,
  modo             VARCHAR(20)   NOT NULL DEFAULT 'dudas',
        -- valores: 'dudas' | 'evaluar'

  -- Metadatos extraídos automáticamente de la respuesta
  tema             VARCHAR(100),
        -- ej: 'ensayo argumentativo', 'falacias', 'análisis de texto'
  nivel            VARCHAR(20),
        -- valores: 'básico' | 'intermedio' | 'avanzado'
  puntaje_total    SMALLINT,
        -- solo para modo 'evaluar', valor 0-100

  -- Métricas de uso
  tokens_usados    INT,
  duracion_ms      INT,          -- tiempo de respuesta en milisegundos

  -- Feedback del estudiante (botón 👍/👎)
  feedback_util    BOOLEAN,      -- NULL = no respondió, TRUE = útil, FALSE = no útil

  created_at       TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inter_estudiante  ON interacciones(estudiante_id);
CREATE INDEX IF NOT EXISTS idx_inter_sesion      ON interacciones(sesion_id);
CREATE INDEX IF NOT EXISTS idx_inter_modo        ON interacciones(modo);
CREATE INDEX IF NOT EXISTS idx_inter_tema        ON interacciones(tema);
CREATE INDEX IF NOT EXISTS idx_inter_fecha       ON interacciones(created_at);


-- ── VISTA: resumen_por_estudiante ─────────────
-- Consulta rápida para el panel del docente
CREATE OR REPLACE VIEW resumen_por_estudiante AS
SELECT
  e.id,
  e.nombre,
  e.email,
  COUNT(i.id)                                           AS total_interacciones,
  COUNT(i.id) FILTER (WHERE i.modo = 'dudas')           AS total_dudas,
  COUNT(i.id) FILTER (WHERE i.modo = 'evaluar')         AS total_evaluaciones,
  ROUND(AVG(i.puntaje_total) FILTER (
    WHERE i.puntaje_total IS NOT NULL), 1)               AS promedio_puntaje,
  COUNT(i.id) FILTER (WHERE i.feedback_util = TRUE)     AS respuestas_utiles,
  COUNT(i.id) FILTER (WHERE i.feedback_util = FALSE)    AS respuestas_no_utiles,
  MAX(i.created_at)                                     AS ultima_actividad,
  COUNT(DISTINCT DATE(i.created_at))                    AS dias_activo
FROM estudiantes e
LEFT JOIN interacciones i ON e.id = i.estudiante_id
WHERE e.activo = TRUE
GROUP BY e.id, e.nombre, e.email;


-- ── VISTA: temas_populares ────────────────────
-- Los temas más consultados por el grupo completo
CREATE OR REPLACE VIEW temas_populares AS
SELECT
  tema,
  COUNT(*)                                              AS consultas,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)   AS porcentaje,
  COUNT(DISTINCT estudiante_id)                         AS estudiantes_distintos,
  MODE() WITHIN GROUP (ORDER BY nivel)                  AS nivel_predominante
FROM interacciones
WHERE tema IS NOT NULL
GROUP BY tema
ORDER BY consultas DESC;


-- ── DATOS DE EJEMPLO (opcional) ───────────────
-- Descomenta si quieres probar con datos ficticios

/*
INSERT INTO estudiantes (nombre, email, password) VALUES
  ('Ana García',    'ana@escuela.edu',    '$2b$10$hash...'),
  ('Luis Martínez', 'luis@escuela.edu',   '$2b$10$hash...'),
  ('Marta López',   'marta@escuela.edu',  '$2b$10$hash...'),
  ('Carlos Ruiz',   'carlos@escuela.edu', '$2b$10$hash...'),
  ('Sofía Pérez',   'sofia@escuela.edu',  '$2b$10$hash...');
*/
