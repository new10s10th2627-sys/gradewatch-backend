// GradeWatch backend — a tiny Express server that stores the app's
// shared state (students, exams, records, staff logins) as one JSON
// document in MongoDB Atlas, so every device sees the same data.

const { google } = require("googleapis");

const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

function todayIST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function getSheetsClient() {
  const auth = new google.auth.JWT(GOOGLE_SERVICE_ACCOUNT_EMAIL, null, GOOGLE_PRIVATE_KEY, ["https://www.googleapis.com/auth/spreadsheets"]);
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI; // mongodb+srv://... from Atlas
const API_KEY = process.env.API_KEY || "";   // simple shared secret; set this in Render's env vars

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI environment variable.");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
let collection;

async function start() {
  await client.connect();
  const db = client.db("gradewatch");
  collection = db.collection("app_state");
  console.log("Connected to MongoDB.");

  const app = express();
  app.use(cors()); // allow the frontend, wherever it's hosted, to call this API
  app.use(express.json({ limit: "5mb" }));

  // simple shared-secret check — every request from the frontend must send this header
  app.use((req, res, next) => {
    if (!API_KEY) return next(); // if no API_KEY is set, auth is skipped (fine for quick testing only)
    if (req.header("x-api-key") === API_KEY) return next();
    return res.status(403).json({ error: "Forbidden: missing or wrong x-api-key header" });
  });

  app.get("/api/state", async (req, res) => {
    try {
      const doc = await collection.findOne({ _id: "state" });
      res.json(doc ? doc.data : null);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load state" });
    }
  });

  app.put("/api/state", async (req, res) => {
    try {
      const data = req.body;
      const existing = await collection.findOne({ _id: "state" });
      const existingCount = existing && existing.data && Array.isArray(existing.data.students) ? existing.data.students.length : 0;
      const incomingCount = data && Array.isArray(data.students) ? data.students.length : 0;
      const force = req.header("x-force-overwrite") === "true";

      // Safety lock: never silently replace real data with an empty roster.
      if (existingCount > 0 && incomingCount === 0 && !force) {
        return res.status(409).json({
          error: "Refusing to save: this would replace " + existingCount + " existing students with an empty list. " +
            "If this is really intended, resend with header x-force-overwrite: true."
        });
      }

      // Keep the previous version as a one-slot backup before overwriting, so a bad save is always recoverable.
      if (existing) {
        await collection.updateOne(
          { _id: "state_backup" },
          { $set: { data: existing.data, savedAt: new Date() } },
          { upsert: true }
        );
      }

      await collection.updateOne(
        { _id: "state" },
        { $set: { data: data, updatedAt: new Date() } },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to save state" });
    }
  });

  // Recovery endpoint: restores state from the one-slot backup taken before the last save.
  app.post("/api/state/restore-backup", async (req, res) => {
    try {
      const backup = await collection.findOne({ _id: "state_backup" });
      if (!backup) return res.status(404).json({ error: "No backup available" });
      await collection.updateOne(
        { _id: "state" },
        { $set: { data: backup.data, updatedAt: new Date() } },
        { upsert: true }
      );
      res.json({ ok: true, restored: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to restore backup" });
    }
  });

  // Exports one day's recheck marks into a Google Sheet (a new tab per date).
  // Meant to be called once daily by an external scheduler (e.g. cron-job.org).
  app.post("/api/export-today", async (req, res) => {
    try {
      if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_SHEET_ID) {
        return res.status(500).json({ error: "Google Sheets export isn't configured yet (missing env vars)." });
      }
      const dateStr = (req.body && req.body.date) || todayIST();
      const doc = await collection.findOne({ _id: "state" });
      if (!doc || !doc.data) return res.status(404).json({ error: "No data found" });
      const state = doc.data;
      const rows = (state.records || [])
        .filter((r) => r.recheckedAt && r.recheckedAt.slice(0, 10) === dateStr)
        .map((r) => {
          const student = (state.students || []).find((s) => s.id === r.studentId);
          const exam = (state.exams || []).find((e) => e.id === r.examId);
          return [
            student ? student.roll : "",
            student ? student.name : "",
            exam ? exam.subject : "",
            exam ? exam.date : "",
            exam ? exam.max : "",
            r.originalMarks,
            r.marks,
            r.marks - r.originalMarks,
            r.recheckedBy || "",
            r.recheckedAt || ""
          ];
        });

      if (rows.length === 0) {
        return res.json({ ok: true, exported: 0, date: dateStr, message: "No recheck entries for " + dateStr });
      }

      const sheets = await getSheetsClient();
      const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
      const existingTab = meta.data.sheets.find((s) => s.properties.title === dateStr);

      if (!existingTab) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: GOOGLE_SHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: dateStr } } }] }
        });
        await sheets.spreadsheets.values.update({
          spreadsheetId: GOOGLE_SHEET_ID,
          range: "'" + dateStr + "'!A1:J1",
          valueInputOption: "RAW",
          requestBody: {
            values: [["Roll No", "Name", "Subject", "Exam Date", "Max Marks", "Student Updated Mark", "Recheck Staff Updated Mark", "Diff", "Recheck Staff", "Recheck Date/Time"]]
          }
        });
      }

      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "'" + dateStr + "'!A:J",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: rows }
      });

      res.json({ ok: true, exported: rows.length, date: dateStr });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Export failed: " + err.message });
    }
  });

  app.get("/", (req, res) => res.send("GradeWatch backend is running."));

  app.listen(PORT, () => console.log("GradeWatch backend listening on port " + PORT));
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
