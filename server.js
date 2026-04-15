const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const DATA_FILE = path.join(__dirname, "reports.json");
const PORT = process.env.PORT || 3001;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-this-secret";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function loadReports() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}

function saveReport(report) {
  const reports = loadReports();
  reports.unshift(report);
  fs.writeFileSync(DATA_FILE, JSON.stringify(reports.slice(0, 52), null, 2));
}

function parseZipBuffer(buffer) {
  const files = {};
  let offset = 0;
  while (offset < buffer.length - 4) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);
    const fileName = buffer.slice(offset + 30, offset + 30 + fileNameLength).toString("utf8");
    const dataOffset = offset + 30 + fileNameLength + extraFieldLength;
    const compressedData = buffer.slice(dataOffset, dataOffset + compressedSize);
    try {
      if (compression === 0) {
        files[fileName] = compressedData;
      } else if (compression === 8) {
        files[fileName] = zlib.inflateRawSync(compressedData);
      }
    } catch(e) {}
    offset = dataOffset + compressedSize;
  }
  return files;
}

function parseXLSX(buffer) {
  const files = parseZipBuffer(buffer);

  // Log all files found in the xlsx for debugging
  console.log(`[XLSX files found]: ${Object.keys(files).join(", ")}`);

  // Get shared strings
  let sharedStrings = [];
  const ssBuffer = files["xl/sharedStrings.xml"];
  if (ssBuffer) {
    const xml = ssBuffer.toString("utf8");
    const matches = xml.match(/<t[^>]*>([^<]*)<\/t>/g) || [];
    sharedStrings = matches.map(m => m.replace(/<[^>]+>/g, "").trim());
  }

  // Find any sheet file — try sheet1 first, then any worksheet
  let sheetBuffer = files["xl/worksheets/sheet1.xml"];
  if (!sheetBuffer) {
    // Try to find any worksheet
    const sheetKey = Object.keys(files).find(k => k.startsWith("xl/worksheets/") && k.endsWith(".xml"));
    if (sheetKey) {
      console.log(`[XLSX] Using sheet: ${sheetKey}`);
      sheetBuffer = files[sheetKey];
    }
  }

  if (!sheetBuffer) throw new Error("No worksheet found in xlsx");

  const sheetXml = sheetBuffer.toString("utf8");
  const rows = sheetXml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
  const result = [];

  for (const row of rows) {
    const cells = row.match(/<c[^>]*>[\s\S]*?<\/c>/g) || [];
    const rowData = [];
    for (const cell of cells) {
      const typeMatch = cell.match(/t="([^"]*)"/);
      const valueMatch = cell.match(/<v>([^<]*)<\/v>/);
      const type = typeMatch ? typeMatch[1] : "";
      const rawValue = valueMatch ? valueMatch[1] : "";
      if (type === "s") {
        rowData.push(sharedStrings[parseInt(rawValue)] || "");
      } else {
        rowData.push(rawValue);
      }
    }
    if (rowData.some(v => v !== "")) {
      result.push(rowData.join(" | "));
    }
  }

  return result.join("\n");
}

const SYSTEM_PROMPT = `You are a seasoned restaurant operations consultant with 20+ years experience. 
You receive weekly KPI reports from restaurant locations and provide brutal, specific analysis.

Respond ONLY with a raw JSON object (no markdown, no backticks):
{
  "location": "restaurant name",
  "reportWeek": "period/week label",
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

async function analyzeWithClaude(fileContent, filename) {
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
        content: [{
          type: "text",
          text: `Here is the restaurant KPI report data from ${filename}:\n\n${fileContent}\n\nAnalyze every metric. Extract all KPIs, benchmark against industry standards, identify top issues, and give hard 7-day recommendations. Return ONLY raw JSON.`
        }]
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

app.post("/api/analyze", async (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { filename, base64PDF, emailSubject, emailFrom, emailDate } = req.body;

  if (!filename) return res.status(400).json({ error: "Missing filename" });

  const lname = filename.toLowerCase();
  const isXLSX = lname.endsWith(".xlsx") || lname.endsWith(".xls");
  const isCSV  = lname.endsWith(".csv");

  if (!isXLSX && !isCSV) {
    console.log(`[${new Date().toISOString()}] Skipped: ${filename}`);
    return res.status(200).json({ skipped: true });
  }

  if (!base64PDF) return res.status(400).json({ error: "Missing file data" });

  try {
    console.log(`[${new Date().toISOString()}] Processing: ${filename}`);
    let fileContent;

    if (isCSV) {
      fileContent = Buffer.from(base64PDF, "base64").toString("utf8");
      console.log(`[${new Date().toISOString()}] CSV decoded: ${fileContent.length} chars`);
    } else {
      const buffer = Buffer.from(base64PDF, "base64");
      console.log(`[${new Date().toISOString()}] XLSX buffer: ${buffer.length} bytes`);
      fileContent = parseXLSX(buffer);
      console.log(`[${new Date().toISOString()}] XLSX parsed: ${fileContent.length} chars`);
    }

    console.log(`[${new Date().toISOString()}] Analyzing: ${filename}`);
    const analysis = await analyzeWithClaude(fileContent, filename);

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

app.get("/api/reports", (req, res) => res.json(loadReports()));
app.get("/api/health", (req, res) => res.json({ status: "ok", reports: loadReports().length }));

app.listen(PORT, () => {
  console.log(`Restaurant Intelligence API running on port ${PORT}`);
  if (!ANTHROPIC_API_KEY) console.warn("WARNING: ANTHROPIC_API_KEY not set!");
});
