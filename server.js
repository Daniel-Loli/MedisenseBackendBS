// ======================================================
// MEDISENSE AI - BACKEND NEGOCIO (VERSIÓN CON VERIFICACIÓN + CHAT LOG)
// ======================================================

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const allowedOrigins = [
  "http://localhost:5173",
  "https://medisenseprueba.onrender.com"
];

app.use(cors({
  origin: function(origin, callback) {
    // Permitir llamadas sin origen (Ej: Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.warn("❌ Bloqueado por CORS:", origin);
      return callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

// ======================================================
// 1. CONEXIÓN BD
// ======================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.connect()
  .then(() => console.log("✅ Conectado a la BD"))
  .catch((err) => console.error("❌ Error BD:", err));

// ======================================================
// SENDGRID - ENVÍO REAL DE CÓDIGOS
// ======================================================
const sgMail = require('@sendgrid/mail');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid inicializado correctamente");
} else {
  console.warn("⚠️ SENDGRID_API_KEY no configurado. No se enviarán correos reales.");
}

async function sendVerificationEmail(toEmail, code) {
  const msg = {
    to: toEmail,
    from: process.env.MAIL_FROM || "no-reply@medisense.ai",
    subject: "Código de verificación - MediSense AI",
    text: `Tu código de verificación es: ${code}. Este código expira en 1 minuto.`,
    html: `
      <div style="font-family: Arial; padding: 15px;">
        <h2 style="color:#0078ff;">MediSense AI</h2>
        <p>Tu código de verificación es:</p>
        <h1 style="background:#f0f4ff;padding:10px;border-radius:8px;text-align:center;">
          ${code}
        </h1>
        <p>Este código expira en <b>1 minuto</b>.</p>
      </div>
    `
  };

  try {
    await sgMail.send(msg);
    console.log("📧 Email enviado correctamente a:", toEmail);
  } catch (error) {
    console.error("❌ Error al enviar correo SendGrid:", error.response?.body || error);
  }
}

// ======================================================
// 2. MIDDLEWARE DE AUTENTICACIÓN (para médicos / dashboard)
// ======================================================

function authRequired(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Token faltante" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token inválido" });
  }
}

// ======================================================
// 3A. CREAR USUARIO MÉDICO
// ======================================================

app.post("/api/users/create", async (req, res) => {
  try {
    const { name, email, password, specialty } = req.body;

    if (!name || !email || !password || !specialty) {
      return res.status(400).json({ message: "Campos incompletos" });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email=$1",
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "El usuario ya existe" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const q = await pool.query(
      `INSERT INTO users(name, email, password_hash, specialty, is_active)
       VALUES($1,$2,$3,$4,true) RETURNING *`,
      [name, email, password_hash, specialty]
    );

    res.json({
      message: "Usuario médico creado exitosamente",
      user: q.rows[0]
    });
  } catch (err) {
    console.error("Error al crear usuario:", err);
    res.status(500).json({ message: "Error interno", error: err });
  }
});

// ======================================================
// 3B. LOGIN MÉDICO
// ======================================================

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const q = await pool.query(
    "SELECT * FROM users WHERE email=$1 AND is_active=true",
    [email]
  );

  if (q.rows.length === 0)
    return res.status(401).json({ message: "Credenciales inválidas" });

  const user = q.rows[0];

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ message: "Credenciales inválidas" });

  const token = jwt.sign(
    { userId: user.id, specialty: user.specialty },
    process.env.JWT_SECRET,
    { expiresIn: "10h" }
  );

  res.json({
    message: "Login exitoso",
    user: {
      id: user.id,
      name: user.name,
      specialty: user.specialty,
      email: user.email,
    },
    token,
  });
});

// ======================================================
// 4. PACIENTES (para dashboard + IA backend)
// ======================================================

app.post("/api/patients", authRequired, async (req, res) => {
  const { nombres, apellidos, dni, whatsapp, email } = req.body;
  const full_name = `${nombres} ${apellidos}`;

  const q = await pool.query(
    `INSERT INTO patients(full_name, document_number, whatsapp_number, email)
     VALUES($1,$2,$3,$4) RETURNING *`,
    [full_name, dni, whatsapp, email]
  );

  res.json({ message: "Paciente creado correctamente", data: q.rows[0] });
});

app.get("/api/patients/by-dni/:dni", async (req, res) => {
  const { dni } = req.params;

  const q = await pool.query(
    "SELECT * FROM patients WHERE document_number=$1",
    [dni]
  );

  if (q.rows.length === 0) {
    return res.status(404).json({ exists: false, message: "Paciente no encontrado" });
  }

  res.json({
    exists: true,
    patient: q.rows[0]
  });
});

// ======================================================
// 5. VERIFICACIÓN DE PACIENTE (DNI + CÓDIGO POR EMAIL)
// ======================================================

app.post("/api/patients/send-code", async (req, res) => {
  try {
    const { dni } = req.body;

    if (!dni) {
      return res.status(400).json({ message: "DNI es requerido" });
    }

    const p = await pool.query(
      "SELECT * FROM patients WHERE document_number=$1",
      [dni]
    );

    if (p.rows.length === 0) {
      return res.status(404).json({ message: "Paciente no encontrado" });
    }

    const patient = p.rows[0];

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 1 * 60 * 1000);

    await pool.query(
      `INSERT INTO patient_verification_codes(patient_id, code, expires_at)
       VALUES($1,$2,$3)`,
      [patient.id, code, expiresAt]
    );

    await sendVerificationEmail(patient.email, code);

    res.json({
      message: "Código de verificación enviado al correo registrado.",
      expires_at: expiresAt
    });

  } catch (err) {
    console.error("Error al enviar código:", err);
    res.status(500).json({ message: "Error interno", error: err });
  }
});

app.post("/api/patients/verify-code", async (req, res) => {
  try {
    const { dni, code } = req.body;

    if (!dni || !code) {
      return res.status(400).json({ message: "DNI y código son requeridos" });
    }

    const p = await pool.query(
      "SELECT * FROM patients WHERE document_number=$1",
      [dni]
    );

    if (p.rows.length === 0) {
      return res.status(404).json({ message: "Paciente no encontrado" });
    }

    const patient = p.rows[0];

    const q = await pool.query(
      `SELECT * FROM patient_verification_codes
       WHERE patient_id=$1 AND is_used=false
       ORDER BY created_at DESC
       LIMIT 1`,
      [patient.id]
    );

    if (q.rows.length === 0) {
      return res.status(400).json({ message: "No hay código activo para este paciente" });
    }

    const record = q.rows[0];
    const now = new Date();

    if (record.code !== code) {
      return res.status(400).json({ message: "Código incorrecto" });
    }

    if (now > record.expires_at) {
      return res.status(400).json({ message: "El código ha expirado" });
    }

    await pool.query(
      `UPDATE patient_verification_codes
       SET is_used=true
       WHERE id=$1`,
      [record.id]
    );

    res.json({
      message: "Verificación exitosa",
      verified: true,
      patient: patient
    });

  } catch (err) {
    console.error("Error al verificar código:", err);
    res.status(500).json({ message: "Error interno", error: err });
  }
});

// ======================================================
// 6. CREAR CASO DESDE IA (SIN APROBACIÓN, CITA OBLIGATORIA)
// ======================================================

app.post("/api/cases/from-ia", async (req, res) => {
  const {
    patient,
    conversation_summary,
    symptoms,
    specialty,
    risk_level,
    possible_diagnosis,
    recommended_treatment,
    diagnosis_justification,
    appointment_time
  } = req.body;

  console.log("🧪 PETICIÓN /cases/from-ia specialty:", specialty);

  if (!appointment_time) {
    return res.status(400).json({
      message: "El usuario debe elegir una fecha y hora para la cita."
    });
  }

  // 1. Buscar o crear paciente
  let q1 = await pool.query(
    "SELECT * FROM patients WHERE document_number=$1",
    [patient.dni]
  );

  let patientRecord;

  if (q1.rows.length === 0) {
    const full_name = `${patient.nombres} ${patient.apellidos}`;
    const insert = await pool.query(
      `INSERT INTO patients(full_name, document_number, whatsapp_number, email)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [full_name, patient.dni, patient.whatsapp, patient.email]
    );
    patientRecord = insert.rows[0];
  } else {
    patientRecord = q1.rows[0];
  }

  // 2. Buscar médico por especialidad (case-insensitive)
  const normalizedSpecialty = (specialty || "Medicina General").trim();
  console.log("🔍 Buscando médico para especialidad:", normalizedSpecialty);

  const doc = await pool.query(
    "SELECT * FROM users WHERE LOWER(specialty) = LOWER($1) LIMIT 1",
    [normalizedSpecialty]
  );

  if (doc.rows.length === 0) {
    console.warn("⚠️ No existe médico para esa especialidad:", normalizedSpecialty);
    return res.status(400).json({ message: "No existe médico para esa especialidad" });
  }

  const doctor = doc.rows[0];

  // 3. Convertir síntomas
  let symptomsArray = Array.isArray(symptoms)
    ? symptoms
    : typeof symptoms === "string"
    ? symptoms.split(",").map(s => s.trim())
    : [];

  // 4. Crear caso (status = REGISTRADO)
  const newCase = await pool.query(
    `INSERT INTO cases(
      patient_id, assigned_doctor_id, specialty,
      risk_level, status,
      ai_summary, ai_symptoms,
      possible_diagnosis, recommended_treatment, diagnosis_justification,
      estimated_price
    )
    VALUES($1,$2,$3,$4,'REGISTRADO',$5,$6,$7,$8,$9,8.00)
    RETURNING *`,
    [
      patientRecord.id,
      doctor.id,
      normalizedSpecialty,
      risk_level,
      conversation_summary,
      JSON.stringify(symptomsArray),
      possible_diagnosis,
      recommended_treatment,
      diagnosis_justification
    ]
  );

  // 5. Crear cita CONFIRMADA automáticamente
  const newAppointment = await pool.query(
    `INSERT INTO appointments(
      case_id, patient_id, doctor_id, specialty,
      scheduled_date, status, price
    )
    VALUES($1,$2,$3,$4,$5,'CONFIRMADA',8.00)
    RETURNING *`,
    [
      newCase.rows[0].id,
      patientRecord.id,
      doctor.id,
      normalizedSpecialty,
      appointment_time
    ]
  );

  res.json({
    message: "Caso clínico registrado y cita confirmada.",
    case: newCase.rows[0],
    appointment: newAppointment.rows[0]
  });
});

// ======================================================
// 7. LISTAR CASOS DEL MÉDICO
// ======================================================

app.get("/api/cases", authRequired, async (req, res) => {
  const q = await pool.query(
    `SELECT c.*, 
            p.full_name AS patient_name,
            p.document_number AS dni
     FROM cases c
     JOIN patients p ON p.id = c.patient_id
     WHERE assigned_doctor_id=$1
     ORDER BY c.created_at DESC`,
    [req.user.userId]
  );

  q.rows.forEach(row => {
    try {
      row.ai_symptoms = JSON.parse(row.ai_symptoms);
    } catch {
      row.ai_symptoms = [];
    }
  });

  res.json({ data: q.rows });
});

// ======================================================
// 8. LISTAR CITAS DEL MÉDICO
// ======================================================

app.get("/api/appointments", authRequired, async (req, res) => {
  const q = await pool.query(
    `SELECT a.*, p.full_name AS patient_name, p.document_number AS dni
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     WHERE doctor_id=$1
     ORDER BY a.scheduled_date ASC`,
    [req.user.userId]
  );

  res.json({ data: q.rows });
});

// ======================================================
// 9. REGISTRO DE TIPS / CONSEJOS (WELLNESS)
// ======================================================

app.post("/api/wellness/log", async (req, res) => {
  try {
    const { patient, user_message, ai_response, category } = req.body;

    if (!patient || !user_message || !ai_response) {
      return res.status(400).json({ message: "Datos incompletos" });
    }

    let p = await pool.query(
      "SELECT * FROM patients WHERE document_number=$1",
      [patient.dni]
    );

    let patientRecord;

    if (p.rows.length === 0) {
      const full = `${patient.nombres} ${patient.apellidos}`;
      const insert = await pool.query(
        `INSERT INTO patients(full_name, document_number, whatsapp_number, email)
         VALUES($1,$2,$3,$4) RETURNING *`,
        [full, patient.dni, patient.whatsapp, patient.email]
      );
      patientRecord = insert.rows[0];
    } else {
      patientRecord = p.rows[0];
    }

    const log = await pool.query(
      `INSERT INTO wellness_logs(user_message, ai_response, category, patient_id)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [user_message, ai_response, category, patientRecord.id]
    );

    res.json({ message: "Tip registrado", data: log.rows[0] });

  } catch (err) {
    console.error("Error logging wellness:", err);
    res.status(500).json({ message: "Error interno", error: err });
  }
});

// ======================================================
// 10. REGISTRO DE CONVERSACIONES (HISTORIAL CHAT WHATSAPP)
// ======================================================

app.post("/api/conversations/log", async (req, res) => {
  try {
    const { dni, case_id, sender, message } = req.body;

    if (!dni || !sender || !message) {
      return res.status(400).json({ message: "dni, sender y message son requeridos" });
    }

    const p = await pool.query(
      "SELECT * FROM patients WHERE document_number=$1",
      [dni]
    );

    if (p.rows.length === 0) {
      return res.status(404).json({ message: "Paciente no encontrado" });
    }

    const patient = p.rows[0];

    const conv = await pool.query(
      `INSERT INTO conversations(patient_id, case_id, sender, message)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [patient.id, case_id || null, sender, message]
    );

    res.json({ message: "Mensaje registrado", data: conv.rows[0] });

  } catch (err) {
    console.error("Error registrando conversación:", err);
    res.status(500).json({ message: "Error interno", error: err });
  }
});

app.get("/api/conversations/by-patient/:dni", authRequired, async (req, res) => {
  const { dni } = req.params;

  const p = await pool.query(
    "SELECT * FROM patients WHERE document_number=$1",
    [dni]
  );

  if (p.rows.length === 0) {
    return res.status(404).json({ message: "Paciente no encontrado" });
  }

  const patient = p.rows[0];

  const q = await pool.query(
    `SELECT * FROM conversations
     WHERE patient_id=$1
     ORDER BY created_at ASC`,
    [patient.id]
  );

  res.json({ data: q.rows });
});

// ======================================================
// 11. SERVIDOR
// ======================================================

app.get("/", (req, res) => res.send("MediSense AI Backend ON"));

app.listen(process.env.PORT || 4000, () =>
  console.log("🚀 Backend corriendo en puerto", process.env.PORT || 4000)
);
