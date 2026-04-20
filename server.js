// ─────────────────────────────────────────────
// server.js — Backend con Google Gemini
// Stack: Node.js + Express + PostgreSQL + Gemini
// ─────────────────────────────────────────────

const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.options('*', cors());
app.use(express.json());

// ── CONEXIÓN A BASE DE DATOS ──────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'asistente_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// ── SYSTEM PROMPT ─────────────────────────────
const SYSTEM_PROMPT = `
Eres un asistente educativo del curso de Argumentación para estudiantes
de bachillerato (15 a 17 años). Tu función es ayudarles a comprender y
mejorar sus habilidades de escritura argumentativa y análisis de textos.

Solo respondes sobre estos temas del curso:
- Ensayo argumentativo: estructura, tesis, desarrollo, conclusión
- Análisis de textos y discursos: tesis, argumentos, falacias, retórica
- Tipos de argumentos: deductivo, inductivo, analógico, de autoridad
- Falacias: ad hominem, hombre de paja, pendiente resbaladiza, etc.

Si el tema está fuera del curso responde:
"Esa pregunta está fuera del temario. Te recomiendo consultar a tu docente."

MODO DUDAS:
- Tono amigable y paciente. Son estudiantes de 15-17 años.
- Usa ejemplos cotidianos y concretos.
- No des la respuesta directa: guía con preguntas.
- Al final de tu respuesta incluye exactamente esta línea:
  [Tema: <tema> | Nivel: <básico|intermedio|avanzado>]

MODO EVALUACIÓN:
Cuando recibas un texto para evaluar, aplica esta rúbrica (100 puntos):
- Tesis clara y defendible: 20 pts
- Calidad y relevancia de argumentos: 25 pts
- Uso de evidencia y fuentes: 20 pts
- Estructura y coherencia: 20 pts
- Refutación de contraargumentos: 15 pts

Devuelve la evaluación en este formato exacto:
##EVAL_START##
CRITERIO:Tesis clara y defendible|PUNTAJE:X/20|COMENTARIO:comentario aquí
CRITERIO:Calidad de argumentos|PUNTAJE:X/25|COMENTARIO:comentario aquí
CRITERIO:Evidencia y fuentes|PUNTAJE:X/20|COMENTARIO:comentario aquí
CRITERIO:Estructura y coherencia|PUNTAJE:X/20|COMENTARIO:comentario aquí
CRITERIO:Refutación|PUNTAJE:X/15|COMENTARIO:comentario aquí
TOTAL:XX/100
NIVEL:Básico|En desarrollo|Sólido|Destacado
FORTALEZA:fortaleza 1
FORTALEZA:fortaleza 2
MEJORA:área de mejora 1
MEJORA:área de mejora 2
SIGUIENTE:un solo paso concreto a seguir
##EVAL_END##

Responde siempre en español. No hagas el trabajo por el estudiante.
`.trim();

// ── CLIENTE GEMINI ────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  systemInstruction: SYSTEM_PROMPT,
});

// ─────────────────────────────────────────────
// RUTAS DE LA API
// ─────────────────────────────────────────────

// ── POST /api/chat ────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { estudiante_id, mensaje, modo, historial = [] } = req.body;

  if (!estudiante_id || !mensaje) {
    return res.status(400).json({ error: 'Faltan campos: estudiante_id, mensaje' });
  }

  const inicio = Date.now();

  try {
    const sesion = await obtenerOCrearSesion(estudiante_id);

    const historialGemini = historial.map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const mensajeEnviado = modo === 'evaluar'
      ? `Por favor evalúa el siguiente texto con la rúbrica del curso:\n\n${mensaje}`
      : mensaje;

    const chat = model.startChat({ history: historialGemini });
    const resultado = await chat.sendMessage(mensajeEnviado);
    const textoRespuesta = resultado.response.text();

    const duracionMs = Date.now() - inicio;
    const meta = extraerMetadatos(mensaje, textoRespuesta, modo);

    const interaccion = await guardarInteraccion({
      sesion_id:       sesion.id,
      estudiante_id,
      mensaje_usuario: mensaje,
      respuesta_ia:    textoRespuesta,
      modo:            modo || 'dudas',
      tema:            meta.tema,
      nivel:           meta.nivel,
      puntaje_total:   meta.puntaje,
      tokens_usados:   null,
      duracion_ms:     duracionMs,
    });

    res.json({
      respuesta:      textoRespuesta,
      interaccion_id: interaccion.id,
      meta,
    });

  } catch (error) {
    console.error('Error en /api/chat:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /api/feedback ────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { interaccion_id, util } = req.body;
  if (!interaccion_id || util === undefined) {
    return res.status(400).json({ error: 'Faltan campos' });
  }
  await db.query(
    'UPDATE interacciones SET feedback_util = $1 WHERE id = $2',
    [util, interaccion_id]
  );
  res.json({ ok: true });
});

// ── GET /api/docente/resumen ──────────────────
app.get('/api/docente/resumen', async (req, res) => {
  const { desde, hasta } = req.query;
  const resultado = await db.query(`
    SELECT
      COUNT(*)                                        AS total_interacciones,
      COUNT(DISTINCT estudiante_id)                   AS estudiantes_activos,
      ROUND(AVG(puntaje_total) FILTER (
        WHERE puntaje_total IS NOT NULL), 1)           AS promedio_puntaje,
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE feedback_util = true)
        / NULLIF(COUNT(*) FILTER (WHERE feedback_util IS NOT NULL), 0)
      , 1)                                            AS porcentaje_util,
      MODE() WITHIN GROUP (ORDER BY tema)             AS tema_mas_consultado
    FROM interacciones
    WHERE ($1::date IS NULL OR created_at >= $1)
      AND ($2::date IS NULL OR created_at <= $2)
  `, [desde || null, hasta || null]);
  res.json(resultado.rows[0]);
});

// ── GET /api/docente/estudiantes ──────────────
app.get('/api/docente/estudiantes', async (req, res) => {
  const resultado = await db.query(`
    SELECT
      e.id, e.nombre, e.email,
      COUNT(i.id)                                     AS total_interacciones,
      COUNT(i.id) FILTER (WHERE i.modo = 'evaluar')   AS tareas_evaluadas,
      ROUND(AVG(i.puntaje_total) FILTER (
        WHERE i.puntaje_total IS NOT NULL), 1)         AS promedio_puntaje,
      MAX(i.created_at)                               AS ultima_actividad,
      MODE() WITHIN GROUP (ORDER BY i.nivel)          AS nivel_frecuente
    FROM estudiantes e
    LEFT JOIN interacciones i ON e.id = i.estudiante_id
    GROUP BY e.id, e.nombre, e.email
    ORDER BY total_interacciones DESC
  `);
  res.json(resultado.rows);
});

// ── GET /api/docente/estudiante/:id ───────────
app.get('/api/docente/estudiante/:id', async (req, res) => {
  const { id } = req.params;
  const [metricas, historial, temas] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*)                                      AS total_interacciones,
        COUNT(*) FILTER (WHERE modo = 'evaluar')      AS tareas_evaluadas,
        ROUND(AVG(puntaje_total) FILTER (
          WHERE puntaje_total IS NOT NULL), 1)         AS promedio_puntaje,
        ROUND(AVG(duracion_ms) / 1000.0, 1)           AS promedio_segundos,
        COUNT(*) FILTER (WHERE feedback_util = true)  AS respuestas_utiles
      FROM interacciones WHERE estudiante_id = $1
    `, [id]),
    db.query(`
      SELECT id, mensaje_usuario, respuesta_ia, modo,
             tema, nivel, puntaje_total, feedback_util, created_at
      FROM interacciones
      WHERE estudiante_id = $1
      ORDER BY created_at DESC LIMIT 10
    `, [id]),
    db.query(`
      SELECT tema, COUNT(*) AS cantidad
      FROM interacciones
      WHERE estudiante_id = $1 AND tema IS NOT NULL
      GROUP BY tema ORDER BY cantidad DESC
    `, [id]),
  ]);
  res.json({
    metricas:  metricas.rows[0],
    historial: historial.rows,
    temas:     temas.rows,
  });
});

// ─────────────────────────────────────────────
// FUNCIONES AUXILIARES
// ─────────────────────────────────────────────

async function obtenerOCrearSesion(estudiante_id) {
  const existente = await db.query(`
    SELECT id FROM sesiones
    WHERE estudiante_id = $1
      AND updated_at > NOW() - INTERVAL '30 minutes'
    ORDER BY updated_at DESC LIMIT 1
  `, [estudiante_id]);

  if (existente.rows.length > 0) {
    await db.query(
      'UPDATE sesiones SET updated_at = NOW() WHERE id = $1',
      [existente.rows[0].id]
    );
    return existente.rows[0];
  }

  const nueva = await db.query(
    'INSERT INTO sesiones (estudiante_id) VALUES ($1) RETURNING id',
    [estudiante_id]
  );
  return nueva.rows[0];
}

async function guardarInteraccion(datos) {
  const resultado = await db.query(`
    INSERT INTO interacciones (
      sesion_id, estudiante_id, mensaje_usuario, respuesta_ia,
      modo, tema, nivel, puntaje_total, tokens_usados, duracion_ms
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING id
  `, [
    datos.sesion_id, datos.estudiante_id,
    datos.mensaje_usuario, datos.respuesta_ia,
    datos.modo, datos.tema, datos.nivel,
    datos.puntaje_total, datos.tokens_usados, datos.duracion_ms,
  ]);
  return resultado.rows[0];
}

function extraerMetadatos(mensaje, respuesta, modo) {
  const meta = { tema: null, nivel: null, puntaje: null };
  const tagMatch = respuesta.match(/\[Tema:\s*([^\|]+)\|\s*Nivel:\s*([^\]]+)\]/i);
  if (tagMatch) {
    meta.tema  = tagMatch[1].trim();
    meta.nivel = tagMatch[2].trim().toLowerCase();
  }
  if (modo === 'evaluar') {
    const totalMatch = respuesta.match(/TOTAL:(\d+)\/100/);
    if (totalMatch) meta.puntaje = parseInt(totalMatch[1]);
    if (!meta.tema) meta.tema = 'evaluación de tarea';
  }
  return meta;
}

// ── INICIAR SERVIDOR ──────────────────────────
app.listen(port, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${port}`);
  console.log(`   Modelo: Gemini 1.5 Flash`);
  console.log(`   Base de datos: ${process.env.DB_NAME || 'asistente_db'}`);
});
