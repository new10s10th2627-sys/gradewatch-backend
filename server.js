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

  app.get("/", (req, res) => res.send("GradeWatch backend is running."));

  app.listen(PORT, () => console.log("GradeWatch backend listening on port " + PORT));
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
