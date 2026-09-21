// GradeWatch backend — a tiny Express server that stores the app's
// shared state (students, exams, records, staff logins) as one JSON
// document in MongoDB Atlas, so every device sees the same data.

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

  app.get("/", (req, res) => res.send("GradeWatch backend is running."));

  app.listen(PORT, () => console.log("GradeWatch backend listening on port " + PORT));
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
