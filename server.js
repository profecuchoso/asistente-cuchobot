const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const { OpenAI } = require('openai');
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json({ limit: '5mb' }));

const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'asistente_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const SYSTEM_PROMPT = `Eres un asistente educativo del curso de Argumentacion para estudiantes de bachillerato de 15 a 17 anos. Tu funcion es ayudarles a comprender y mejorar sus habilidades de escritura argumentativa y analisis de textos.

Solo respondes sobre estos temas del curso:
- Ensayo argumentativo: estructura, tesis, desarrollo, conclusion
- Analisis de textos y discursos: tesis, argumentos, falacias, retorica
- Tipos de argumentos: deductivo, inductivo, analogico, de autoridad
- Falacias: ad hominem, hombre de paja, pendiente resbaladiza, etc.

Si el tema esta fuera del curso responde: "Esa pregunta esta fuera del temario. Te recomiendo consultar a tu docente."

MODO DUDAS:
Distingue entre dos tipos de consultas:

1. DUDAS DE CONTENIDO (que argumentar, que postura tomar, que opinar):
   - NUNCA des la respuesta. Solo haz preguntas abiertas y neutras.
   - Maximo 2 preguntas por respuesta.

2. DUDAS DE FORMA (como estructurar, como redactar, como desarrollar):
   - Da una guia directa y clara sobre estructura o redaccion.
   - Puedes modelar posibilidades de desarrollo con ejemplos genericos sin usar el contenido del estudiante.
   - Si es util, combina la guia con una pregunta al final.

IMPORTANTE EN MODO DUDAS: Si el estudiante pega un texto largo para que lo evalues, NO evalues. Responde: "Para evaluar tu tarea usa el boton Evaluar tarea en la parte superior."

En ambos casos: tono amigable, maximo 3 parrafos.
Al final incluye: [Tema: <tema> | Nivel: basico o intermedio o avanzado]

MODO EVALUACION:
IMPORTANTE: SIEMPRE usa el formato ##EVAL_START## exactamente como esta definido abajo. NUNCA evalues en texto libre. El docente no podra ver el puntaje si no usas este formato exacto.

##EVAL_START##
CRITERIO:Tesis clara y defendible|PUNTAJE:X/15|COMENTARIO:comentario
CRITERIO:Calidad de argumentos|PUNTAJE:X/15|COMENTARIO:comentario
CRITERIO:Evidencia y fuentes|PUNTAJE:X/15|COMENTARIO:comentario
CRITERIO:Estructura y coherencia|PUNTAJE:X/15|COMENTARIO:comentario
CRITERIO:Refutacion|PUNTAJE:X/10|COMENTARIO:comentario
CRITERIO:Interacciones con CUCHOBOT|PUNTAJE:X/10|COMENTARIO:comentario
CRITERIO:Trabajo clase a clase|PUNTAJE:X/10|COMENTARIO:comentario
CRITERIO:Ortografia|PUNTAJE:X/5|COMENTARIO:comentario
CRITERIO:Redaccion|PUNTAJE:X/5|COMENTARIO:comentario
TOTAL:XX/100
NIVEL:Basico o En desarrollo o Solido o Destacado
FORTALEZA:fortaleza 1
FORTALEZA:fortaleza 2
MEJORA:mejora 1
MEJORA:mejora 2
SIGUIENTE:paso concreto
##EVAL_END##

Responde siempre en espanol.`;

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey:  process.env.OPENROUTER_API_KEY,
});

// ── POST /api/login ───────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Faltan email o contraseña' });
  try {
    const result = await db.query(
      'SELECT id, nombre FROM estudiantes WHERE email = $1 AND password = $2 AND activo = TRUE',
      [email.toLowerCase().trim(), password]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });

    const estudiante = result.rows[0];

    // Cargar últimas 20 interacciones para restaurar historial
    const historial = await db.query(`
      SELECT mensaje_usuario, respuesta_ia, modo, created_at
      FROM interacciones
      WHERE estudiante_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [estudiante.id]);

    res.json({
      id:       estudiante.id,
      nombre:   estudiante.nombre,
      historial: historial.rows.reverse(), // orden cronológico
    });
  } catch (error) {
    console.error('Error en /api/login:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /api/cambiar-password ────────────────
app.post('/api/cambiar-password', async (req, res) => {
  const { estudiante_id, password_actual, password_nueva } = req.body;
  if (!estudiante_id || !password_actual || !password_nueva) {
    return res.status(400).json({ error: 'Faltan campos' });
  }
  if (password_nueva.length < 4) {
    return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 4 caracteres' });
  }
  try {
    // Verificar contraseña actual
    const check = await db.query(
      'SELECT id FROM estudiantes WHERE id = $1 AND password = $2',
      [estudiante_id, password_actual]
    );
    if (check.rows.length === 0) {
      return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
    }
    // Actualizar contraseña
    await db.query(
      'UPDATE estudiantes SET password = $1 WHERE id = $2',
      [password_nueva, estudiante_id]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Error en /api/cambiar-password:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /api/chat ────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { estudiante_id, mensaje, modo, historial = [] } = req.body;
  if (!estudiante_id || !mensaje) return res.status(400).json({ error: 'Faltan campos' });

  const inicio = Date.now();
  try {
    const sesion = await obtenerOCrearSesion(estudiante_id);
    const mensajeEnviado = modo === 'evaluar'
      ? 'Por favor evaluame formalmente con nota este texto usando la rubrica del curso:\n\n' + mensaje
      : mensaje;

    const mensajesAPI = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...historial.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      { role: 'user', content: mensajeEnviado },
    ];

    const completion = await openai.chat.completions.create({
      model:    'meta-llama/llama-3.3-70b-instruct',
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

// ── POST /api/feedback ────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { interaccion_id, util } = req.body;
  if (!interaccion_id || util === undefined) return res.status(400).json({ error: 'Faltan campos' });
  await db.query('UPDATE interacciones SET feedback_util = $1 WHERE id = $2', [util, interaccion_id]);
  res.json({ ok: true });
});

// ── GET /api/docente/resumen ──────────────────
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

// ── GET /api/docente/estudiantes ──────────────
app.get('/api/docente/estudiantes', async (req, res) => {
  const r = await db.query(`
    SELECT e.id, e.nombre, e.email, COUNT(i.id) AS total_interacciones,
    COUNT(i.id) FILTER (WHERE i.modo = 'evaluar') AS tareas_evaluadas,
    ROUND(AVG(i.puntaje_total) FILTER (WHERE i.puntaje_total IS NOT NULL), 1) AS promedio_puntaje,
    MAX(i.created_at) AS ultima_actividad,
    MODE() WITHIN GROUP (ORDER BY i.nivel) AS nivel_frecuente
    FROM estudiantes e LEFT JOIN interacciones i ON e.id = i.estudiante_id
    GROUP BY e.id, e.nombre, e.email ORDER BY total_interacciones DESC
  `);
  res.json(r.rows);
});

// ── GET /api/docente/estudiante/:id ───────────
app.get('/api/docente/estudiante/:id', async (req, res) => {
  const { id } = req.params;
  const [metricas, historial, temas] = await Promise.all([
    db.query(`
      SELECT COUNT(*) AS total_interacciones, COUNT(*) FILTER (WHERE modo = 'evaluar') AS tareas_evaluadas,
      ROUND(AVG(puntaje_total) FILTER (WHERE puntaje_total IS NOT NULL), 1) AS promedio_puntaje
      FROM interacciones WHERE estudiante_id = $1
    `, [id]),
    db.query(`
      SELECT id, mensaje_usuario, respuesta_ia, modo, tema, nivel, puntaje_total, feedback_util, created_at
      FROM interacciones WHERE estudiante_id = $1 ORDER BY created_at DESC LIMIT 10
    `, [id]),
    db.query(`
      SELECT tema, COUNT(*) AS cantidad FROM interacciones
      WHERE estudiante_id = $1 AND tema IS NOT NULL GROUP BY tema ORDER BY cantidad DESC
    `, [id]),
  ]);
  res.json({ metricas: metricas.rows[0], historial: historial.rows, temas: temas.rows });
});

// ── FUNCIONES AUXILIARES ──────────────────────
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
    // Buscar TOTAL en múltiples formatos posibles
    const p = respuesta.match(/TOTAL\s*[:：]?\s*\*{0,2}(\d+)\s*\/\s*100/i);
    if (p) meta.puntaje = parseInt(p[1]);
    if (!meta.tema) meta.tema = 'evaluacion de tarea';
  }
  return meta;
}

app.listen(port, () => {
  console.log('Servidor corriendo en http://localhost:' + port);
  console.log('Modelo: llama-3.3-70b via OpenRouter');
  console.log('Base de datos: ' + (process.env.DB_NAME || 'asistente_db'));
});
