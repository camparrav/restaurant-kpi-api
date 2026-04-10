/**
 * Brazen Head Restaurant Intelligence — Backend API
 * 
 * Receives PDF attachments from Power Automate (via HTTP POST),
 * analyzes them with Claude, and stores results for the dashboard.
 * 
 * Deploy to: Railway / Render / Azure App Service / any Node host
 * 
 * Setup:
 *   npm install
 *   Set env vars: ANTHROPIC_API_KEY, WEBHOOK_SECRET
 *   node server.js
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const DATA_FILE = path.join(__dirname, "reports.json");
const PORT = process.env.PORT || 3001;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-this-secret";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Load / Save reports ────────────────────────────────────────────────────
function loadReports() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}

function saveReport(report) {
  const reports = loadReports();
  reports.unshift(report); // newest first
  fs.writeFileSync(DATA_FILE, JSON.stringify(reports.slice(0, 52), null, 2)); // keep 1yr
}

// ─── Claude Analysis ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a seasoned restaurant operations consultant with 20+ years experience. 
You receive weekly KPI reports from restaurant locations and provide brutal, specific analysis.

Respond ONLY with a raw JSON object (no markdown, no backticks):
{
  "location": "restaurant name",
  "reportWeek": "period/week label",
  "receivedAt": "ISO timestamp",
  "overallScore": 72,
  "overallVerdict": "2-3 sentence honest assessment",
  "kpis": [
    {
      "category": "category",
      "name": "metric name", 
      "value": "actual value",
      "benchmark": "industry standard",
      "status": "good|warning|critical",
      "variance": "vs target"
    }
  ],
  "topIssues": [
    { "rank": 1, "issue": "title", "impact": "financial impact", "detail": "2-3 sentences" }
  ],
  "recommendations": [
    {
      "priority": "IMMEDIATE|HIGH|MEDIUM",
      "action": "action title",
      "detail": "exactly what to do, who, when",
      "expectedImpact": "measurable outcome",
      "owner": "GM|Head Chef|FOH Manager|Bar Manager|All Staff"
    }
  ]
}

Use real benchmarks: food cost 28-32%, labour 30-35%, beverage 22-28%, prime cost <65%, promos <5%.
Be ruthlessly specific. Name exact numbers, exact people, exact actions for the next 7 days only.`;

async function analyzeWithClaude(base64PDF, filename) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64PDF } },
          { type: "text", text: `Analyze this restaurant performance report (${filename}). Extract every KPI and give hard 7-day recommendations. Return ONLY raw JSON.` }
        ]
      }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Claude API error ${response.status}: ${err?.error?.message}`);
  }

  const data = await response.json();
  const raw = (data.content || []).map(b => b.type === "text" ? b.text : "").join("").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in Claude response");
  return JSON.parse(raw.slice(start, end + 1));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Power Automate calls this when a new report email arrives
app.post("/api/analyze", async (req, res) => {
  // Simple secret check — Power Automate sends this in the header
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { filename, base64PDF, emailSubject, emailFrom, emailDate } = req.body;

  if (!base64PDF || !filename) {
    return res.status(400).json({ error: "Missing filename or base64PDF" });
  }

  try {
    console.log(`[${new Date().toISOString()}] Analyzing: ${filename}`);
    const analysis = await analyzeWithClaude(base64PDF, filename);

    const report = {
      ...analysis,
      id: `report_${Date.now()}`,
      fileName: filename,
      emailSubject: emailSubject || "",
      emailFrom: emailFrom || "",
      receivedAt: emailDate || new Date().toISOString(),
      analyzedAt: new Date().toISOString(),
    };

    saveReport(report);
    console.log(`[${new Date().toISOString()}] Saved: ${report.location} — Score: ${report.overallScore}`);
    res.json({ success: true, reportId: report.id, score: report.overallScore });
  } catch (err) {
    console.error("Analysis error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard fetches all reports
app.get("/api/reports", (req, res) => {
  res.json(loadReports());
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", reports: loadReports().length });
});

app.listen(PORT, () => {
  console.log(`Restaurant Intelligence API running on port ${PORT}`);
  if (!ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY not set!");
});
