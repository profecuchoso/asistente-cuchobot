const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const { OpenAI } = require('openai');
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'asistente_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const SYSTEM_PROMPT = `Eres un asistente educativo del curso de Argumentación para estudiantes de bachillerato (15 a 17 años). Tu función es ayudarles a comprender y mejorar sus habilidades de escritura argumentativa y análisis de textos.

Solo respondes sobre estos temas del curso:
- Ensayo argumentativo: estructura, tesis, desarrollo, conclusión
- Análisis de textos y discursos: tesis, argumentos, falacias, retórica
- Tipos de argumentos: deductivo, inductivo, analógico, de autoridad
- Falacias: ad hominem, hombre de paja, pendiente resbaladiza, etc.

Si el tema está fuera del curso responde: "Esa pregunta está fuera del temario. Te recomiendo consultar a tu docente."

MODO DUDAS:
MODO DUDAS:
- Tono amigable y paciente. Son estudiantes de 15-17 años.
- Usa ejemplos cotidianos y concretos.
- Guía al estudiante con preguntas, no des la respuesta directa.
- Si el estudiante pide ayuda para mejorar algo (tesis, argumento, texto),
  dale retroalimentación conversacional, NO uses el formato de evaluación.
  El formato ##EVAL_START## solo se usa cuando el estudiante pide
  explícitamente "evalúa mi tarea" o "corrígeme con nota".
- Al final incluye: [Tema: <tema> | Nivel: <básico|intermedio|avanzado>]

MODO EVALUACIÓN - usa este formato exacto:
##EVAL_START##
CRITERIO:Tesis clara y defendible|PUNTAJE:X/20|COMENTARIO:comentario
CRITERIO:Calidad de argumentos|PUNTAJE:X/25|COMENTARIO:comentario
CRITERIO:Evidencia y fuentes|PUNTAJE:X/20|COMENTARIO:comentario
CRITERIO:Estructura y coherencia|PUNTAJE:X/20|COMENTARIO:comentario
CRITERIO:Refutación|PUNTAJE:X/15|COMENTARIO:comentario
TOTAL:XX/100
NIVEL:Básico|En desarrollo|Sólido|Destacado
FORTALEZA:fortaleza 1
FORTALEZA:fortaleza 2
MEJORA:mejora 1
MEJORA:mejora 2
SIGUIENTE:paso concreto
##EVAL_END##

Responde siempre en español.`;

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey:  process.env.OPENROUTER_API_KEY,
});

app.post('/api/chat', async (req, res) => {
  const { estudiante_id, mensaje, modo, historial = [] } = req.body;
  if (!estudiante_id || !mensaje) return res.status(400).json({ error: 'Faltan campos' });

  const inicio = Date.now();
  try {
    const sesion = await obtenerOCrearSesion(estudiante_id);
    const mensajeEnviado = modo === 'evaluar'
      ? `Por favor evalúa el siguiente texto con la rúbrica del curso:\n\n${mensaje}`
      : mensaje;

    const mensajesAPI = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...historial.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      { role: 'user', content: mensajeEnviado },
    ];

    const completion = await openai.chat.completions.create({
      model:    'openrouter/auto',
      messages: mensajesAPI,
    });

    const textoRespuesta = completion.choices[0].message.content;
    const meta = extraerMetadatos(mensaje, textoRespuesta, modo);
    const interaccion = await guardarInteraccion({
      sesion_id: sesion.id, estudiante_id,
      mensaje_usuario: mensaje, respuesta_ia: textoRespuesta,
      modo: modo || 'dudas', tema: meta.tema, nivel: meta.nivel,
      puntaje_total: meta.puntaje, tokens_usados: completion.usage?.total_tokens || null,
      duracion_ms: Date.now() - inicio,
    });
    res.json({ respuesta: textoRespuesta, interaccion_id: interaccion.id, meta });
  } catch (error) {
    console.error('Error en /api/chat:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/feedback', async (req, res) => {
  const { interaccion_id, util } = req.body;
  if (!interaccion_id || util === undefined) return res.status(400).json({ error: 'Faltan campos' });
  await db.query('UPDATE interacciones SET feedback_util = $1 WHERE id = $2', [util, interaccion_id]);
  res.json({ ok: true });
});

app.get('/api/docente/resumen', async (req, res) => {
  const { desde, hasta } = req.query;
  const r = await db.query(`
    SELECT COUNT(*) AS total_interacciones, COUNT(DISTINCT estudiante_id) AS estudiantes_activos,
    ROUND(AVG(puntaje_total) FILTER (WHERE puntaje_total IS NOT NULL), 1) AS promedio_puntaje
    FROM interacciones
    WHERE ($1::date IS NULL OR created_at >= $1) AND ($2::date IS NULL OR created_at <= $2)
  `, [desde || null, hasta || null]);
  res.json(r.rows[0]);
});

app.get('/api/docente/estudiantes', async (req, res) => {
  const r = await db.query(`
    SELECT e.id, e.nombre, e.email, COUNT(i.id) AS total_interacciones,
    ROUND(AVG(i.puntaje_total) FILTER (WHERE i.puntaje_total IS NOT NULL), 1) AS promedio_puntaje,
    MAX(i.created_at) AS ultima_actividad
    FROM estudiantes e LEFT JOIN interacciones i ON e.id = i.estudiante_id
    GROUP BY e.id, e.nombre, e.email ORDER BY total_interacciones DESC
  `);
  res.json(r.rows);
});

async function obtenerOCrearSesion(estudiante_id) {
  const ex = await db.query(`
    SELECT id FROM sesiones WHERE estudiante_id = $1
    AND updated_at > NOW() - INTERVAL '30 minutes' ORDER BY updated_at DESC LIMIT 1
  `, [estudiante_id]);
  if (ex.rows.length > 0) {
    await db.query('UPDATE sesiones SET updated_at = NOW() WHERE id = $1', [ex.rows[0].id]);
    return ex.rows[0];
  }
  const nueva = await db.query('INSERT INTO sesiones (estudiante_id) VALUES ($1) RETURNING id', [estudiante_id]);
  return nueva.rows[0];
}

async function guardarInteraccion(d) {
  const r = await db.query(`
    INSERT INTO interacciones (sesion_id, estudiante_id, mensaje_usuario, respuesta_ia,
    modo, tema, nivel, puntaje_total, tokens_usados, duracion_ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
  `, [d.sesion_id, d.estudiante_id, d.mensaje_usuario, d.respuesta_ia,
      d.modo, d.tema, d.nivel, d.puntaje_total, d.tokens_usados, d.duracion_ms]);
  return r.rows[0];
}

function extraerMetadatos(mensaje, respuesta, modo) {
  const meta = { tema: null, nivel: null, puntaje: null };
  const t = respuesta.match(/\[Tema:\s*([^\|]+)\|\s*Nivel:\s*([^\]]+)\]/i);
  if (t) { meta.tema = t[1].trim(); meta.nivel = t[2].trim().toLowerCase(); }
  if (modo === 'evaluar') {
    const p = respuesta.match(/TOTAL:(\d+)\/100/);
    if (p) meta.puntaje = parseInt(p[1]);
    if (!meta.tema) meta.tema = 'evaluación de tarea';
  }
  return meta;
}

app.listen(port, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${port}`);
  console.log(`   Modelo: OpenRouter Auto`);
  console.log(`   Base de datos: ${process.env.DB_NAME || 'asistente_db'}`);
});
