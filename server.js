/**
 * राजभाषा QPR — Central Server
 * Node.js + Express + SQLite
 * सारा data इसी machine पर rajbhasha.db में store होगा
 *
 * RUN:  node server.js
 * PORT: 3000  (बदलने के लिए नीचे PORT देखें)
 */

const express  = require("express");
const Database = require("better-sqlite3");
const path     = require("path");
const os       = require("os");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database setup ────────────────────────────────────────────────────────────
// rajbhasha.db इसी folder में बनेगी
const DB_PATH = path.join(__dirname, "rajbhasha.db");
const db      = new Database(DB_PATH);

// WAL mode — faster writes, safe on crash
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ack_id      TEXT    UNIQUE NOT NULL,
    section     TEXT    NOT NULL,
    quarter     TEXT    NOT NULL,
    year        TEXT    NOT NULL,
    region      TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'PENDING_AAO',
    score       INTEGER NOT NULL DEFAULT 0,
    data        TEXT    NOT NULL,   -- full JSON blob
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS timeline (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id   INTEGER NOT NULL REFERENCES reports(id),
    ts          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    role        TEXT    NOT NULL,
    user_name   TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    remark      TEXT    DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    user_name   TEXT    NOT NULL,
    role        TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    details     TEXT    DEFAULT ''
  );
`);

console.log(`✅ Database ready: ${DB_PATH}`);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"))); // serves index.html

// CORS — allow all origins on LAN
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Prepared statements (fast, safe, no SQL injection) ────────────────────────
const stmts = {
  insertReport: db.prepare(`
    INSERT INTO reports (ack_id, section, quarter, year, region, status, score, data)
    VALUES (@ack_id, @section, @quarter, @year, @region, @status, @score, @data)
  `),
  updateReport: db.prepare(`
    UPDATE reports SET status=@status, score=@score, data=@data, updated_at=datetime('now','localtime')
    WHERE ack_id=@ack_id
  `),
  updateStatus: db.prepare(`
    UPDATE reports SET status=@status, updated_at=datetime('now','localtime')
    WHERE ack_id=@ack_id
  `),
  getReport:    db.prepare(`SELECT * FROM reports WHERE ack_id=?`),
  getAllReports: db.prepare(`SELECT * FROM reports ORDER BY created_at DESC`),
  getBySection: db.prepare(`SELECT * FROM reports WHERE section=? ORDER BY created_at DESC`),
  getByStatus:  db.prepare(`SELECT * FROM reports WHERE status=? ORDER BY created_at DESC`),
  deleteReport: db.prepare(`DELETE FROM reports WHERE ack_id=?`),

  insertTimeline: db.prepare(`
    INSERT INTO timeline (report_id, role, user_name, action, remark)
    VALUES (@report_id, @role, @user_name, @action, @remark)
  `),
  getTimeline: db.prepare(`
    SELECT * FROM timeline WHERE report_id=? ORDER BY ts ASC
  `),

  insertAudit: db.prepare(`
    INSERT INTO audit_log (user_name, role, action, details) VALUES (?,?,?,?)
  `),
  getAudit: db.prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT 500`),
  clearAudit: db.prepare(`DELETE FROM audit_log`),
};

// helper — parse JSON blob safely
function parseReport(row) {
  if (!row) return null;
  return { ...JSON.parse(row.data), _id: row.id, _status: row.status, _createdAt: row.created_at, _updatedAt: row.updated_at };
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, db: DB_PATH, time: new Date().toLocaleString("hi-IN") });
});

// ── Reports ───────────────────────────────────────────────────────────────────

// GET all reports (MASTER / HINDI_CELL)
app.get("/api/reports", (req, res) => {
  const { section, status } = req.query;
  let rows;
  if (section) rows = stmts.getBySection.all(section);
  else if (status) rows = stmts.getByStatus.all(status);
  else rows = stmts.getAllReports.all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), dbId: r.id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at })));
});

// GET single report with timeline
app.get("/api/reports/:ackId", (req, res) => {
  const row = stmts.getReport.get(req.params.ackId);
  if (!row) return res.status(404).json({ error: "रिपोर्ट नहीं मिली" });
  const report   = { ...JSON.parse(row.data), dbId: row.id, status: row.status, createdAt: row.created_at };
  const timeline = stmts.getTimeline.all(row.id);
  res.json({ report, timeline });
});

// POST new report (Section submits)
app.post("/api/reports", (req, res) => {
  try {
    const report = req.body;
    if (!report.ackId || !report.sectionName) return res.status(400).json({ error: "ackId और sectionName जरूरी हैं" });

    // score compute (basic — same formula as frontend)
    const total6 = (+report.b1_s6_ka_total||0) + (+report.b1_s6_kha_total||0) + (+report.b1_s6_ga_total||0);
    const hindi6 = (+report.b1_s6_ka_hindi||0) + (+report.b1_s6_kha_hindi||0) + (+report.b1_s6_ga_hindi||0);
    const corrPct   = total6 > 0 ? hindi6/total6 : 0;
    const notingPct = +report.b1_s7_totalPages > 0 ? (+report.b1_s7_hindiPages||0) / (+report.b1_s7_totalPages) : 0;
    const workshops = Math.min(+report.b1_s8_workshops||0, 4) / 4;
    const score = Math.round((corrPct*0.40 + notingPct*0.30 + workshops*0.15 + (report.b1_s9_meetingDate?1:0)*0.10 + (report.b1_s10_meetingDate?1:0)*0.05)*100);

    const result = stmts.insertReport.run({
      ack_id:  report.ackId,
      section: report.sectionName,
      quarter: report.quarter,
      year:    report.year,
      region:  report.region || "A",
      status:  "PENDING_AAO",
      score,
      data:    JSON.stringify({ ...report, status: "PENDING_AAO", score }),
    });

    // Timeline entry
    stmts.insertTimeline.run({ report_id: result.lastInsertRowid, role: "SECTION", user_name: report.sectionName, action: "रिपोर्ट जमा की और AAO को भेजी", remark: "" });

    // Audit
    stmts.insertAudit.run(report.sectionName, "SECTION", "CREATE", `रिपोर्ट ${report.ackId} जमा`);

    res.json({ ok: true, ackId: report.ackId, score });
  } catch (err) {
    if (err.message?.includes("UNIQUE")) return res.status(409).json({ error: "यह पावती संख्या पहले से मौजूद है" });
    res.status(500).json({ error: err.message });
  }
});

// PUT — AAO / SAO / Hindi Cell action
app.put("/api/reports/:ackId/action", (req, res) => {
  try {
    const { ackId }             = req.params;
    const { action, remark, user } = req.body;   // action = new status string

    const row = stmts.getReport.get(ackId);
    if (!row) return res.status(404).json({ error: "रिपोर्ट नहीं मिली" });

    const actionLabels = {
      AAO_APPROVED: "AAO ने स्वीकृत किया और SAO को भेजा",
      AAO_RETURNED: "AAO ने अनुभाग को वापस किया",
      SAO_APPROVED: "SAO ने स्वीकृत किया और हिंदी प्रकोष्ठ को भेजा",
      SAO_RETURNED: "SAO ने AAO को वापस किया",
      SUBMITTED:    "हिंदी प्रकोष्ठ ने अंतिम रूप से स्वीकृत किया",
      REJECTED:     "हिंदी प्रकोष्ठ ने अस्वीकृत किया",
    };

    // Update status in reports table
    stmts.updateStatus.run({ status: action, ack_id: ackId });

    // Update status inside JSON blob too
    const data = JSON.parse(row.data);
    data.status = action;
    db.prepare(`UPDATE reports SET data=? WHERE ack_id=?`).run(JSON.stringify(data), ackId);

    // Timeline entry
    stmts.insertTimeline.run({ report_id: row.id, role: user.role, user_name: user.name, action: actionLabels[action] || action, remark: remark || "" });

    // Audit
    stmts.insertAudit.run(user.name, user.role, "ACTION", `${ackId} — ${actionLabels[action] || action}${remark ? ` · "${remark}"` : ""}`);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE report (MASTER only — enforce on frontend)
app.delete("/api/reports/:ackId", (req, res) => {
  const { userName, role } = req.query;
  const row = stmts.getReport.get(req.params.ackId);
  if (!row) return res.status(404).json({ error: "रिपोर्ट नहीं मिली" });
  stmts.deleteReport.run(req.params.ackId);
  stmts.insertAudit.run(userName || "unknown", role || "unknown", "DELETE", `रिपोर्ट ${req.params.ackId} हटाई`);
  res.json({ ok: true });
});

// ── Audit ─────────────────────────────────────────────────────────────────────
app.get("/api/audit", (_, res) => res.json(stmts.getAudit.all()));
app.delete("/api/audit", (_, res) => { stmts.clearAudit.run(); res.json({ ok: true }); });

// ── Stats (dashboard) ─────────────────────────────────────────────────────────
app.get("/api/stats", (_, res) => {
  const counts = db.prepare(`
    SELECT status, COUNT(*) as count FROM reports GROUP BY status
  `).all();
  const avgScore = db.prepare(`SELECT AVG(score) as avg FROM reports`).get();
  const total    = db.prepare(`SELECT COUNT(*) as n FROM reports`).get();
  res.json({ counts, avgScore: Math.round(avgScore.avg || 0), total: total.n });
});

// ── Serve frontend for all other routes ──────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  let lan = "";
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) { lan = addr.address; break; }
    }
    if (lan) break;
  }
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║       राजभाषा QPR — Central Server v4.0         ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Local:   http://localhost:${PORT}                   ║`);
  console.log(`║  Network: http://${lan}:${PORT}          ║`);
  console.log(`║  DB:      ${DB_PATH.slice(-35).padEnd(35)} ║`);
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("\n  👆 दूसरे computers पर Network URL share करें\n");
});
