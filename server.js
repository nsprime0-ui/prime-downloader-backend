import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { execFile } from "child_process";
import util from "util";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const execFileAsync = util.promisify(execFile);

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",");
const ENABLE_CACHING = false;

// ---------- Optional Redis (disabled by default) ----------
let redis = null;
if (ENABLE_CACHING && process.env.REDIS_URL) {
  const IORedis = await import("ioredis");
  redis = new IORedis.default(process.env.REDIS_URL);
  redis.on("error", (e) => console.error("Redis error:", e));
}

// ---------- Middleware ----------
app.use(helmet());
app.use(express.json());
app.use(morgan("tiny"));
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS not allowed"), false);
      }
    },
  })
);

// Rate limit
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---------- Helpers ----------
function humanFileSize(bytes) {
  if (!bytes || isNaN(bytes)) return "Unknown";
  const thresh = 1024;
  if (Math.abs(bytes) < thresh) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let u = -1;
  do {
    bytes /= thresh;
    ++u;
  } while (Math.abs(bytes) >= thresh && u < units.length - 1);
  return bytes.toFixed(1) + " " + units[u];
}

async function getContentLength(url) {
  try {
    const resp = await axios.head(url, { timeout: 10000, maxRedirects: 5 });
    const len = resp.headers["content-length"];
    return len ? parseInt(len, 10) : null;
  } catch {
    return null;
  }
}

function normalizeAndFilterFormats(rawFormats) {
  const out = [];
  const seen = new Set();

  for (const f of rawFormats) {
    if (!f?.url) continue;
    try {
      new URL(f.url);
    } catch {
      continue;
    }
    if (seen.has(f.url)) continue;
    seen.add(f.url);

    let type = "video";
    if (f.vcodec === "none" || (f.acodec && !f.vcodec)) type = "audio";

    const label = f.format_note
      ? `${f.format_note} ${f.height ? f.height + "p" : ""}`.trim()
      : f.height
      ? f.height + "p"
      : f.ext?.toUpperCase() || "Unknown";

    out.push({
      label,
      url: f.url,
      type,
      filesize: f.filesize || f.filesize_approx || null,
      ext: f.ext || null,
    });
  }
  return out;
}

// ---------- API ----------
app.get("/api/check", async (req, res) => {
  try {
    const { stdout } = await execFileAsync("yt-dlp", ["--version"]);
    res.json({ installed: true, version: stdout.trim() });
  } catch (err) {
    res.json({ installed: false, error: err.message });
  }
});

app.get("/api/extract", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "Missing url parameter" });

  try {
    new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }

  const cacheKey = `extract:${targetUrl}`;
  if (ENABLE_CACHING && redis) {
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));
  }

  try {
    const { stdout, stderr } = await execFileAsync("yt-dlp", ["-j", "--no-warnings", targetUrl], {
      maxBuffer: 15 * 1024 * 1024,
    });

    if (stderr) console.error("yt-dlp stderr:", stderr);

    let meta;
    try {
      meta = JSON.parse(stdout);
    } catch {
      const firstLine = stdout.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
      meta = firstLine ? JSON.parse(firstLine) : null;
    }

    if (!meta) throw new Error("yt-dlp returned no valid JSON");

    const rawFormats = meta.formats || [];
    const formats = normalizeAndFilterFormats(rawFormats);

    await Promise.all(
      formats
        .filter((f) => !f.filesize)
        .slice(0, 6)
        .map(async (f) => {
          const len = await getContentLength(f.url);
          if (len) f.filesize = len;
        })
    );

    const mapped = formats.map((f) => ({
      label: f.label,
      size: humanFileSize(f.filesize),
      url: f.url,
      type: f.type,
    }));

    const payload = { title: meta.title, thumbnail: meta.thumbnail, formats: mapped };

    if (ENABLE_CACHING && redis) {
      await redis.set(cacheKey, JSON.stringify(payload), "EX", 300);
    }

    res.json(payload);
  } catch (error) {
    console.error("yt-dlp execution failed:", error);
    res.status(500).json({ error: error.message || "Failed to extract formats" });
  }
});

// ---------- Root ----------
app.get("/", (req, res) => {
  res.send("✅ PrimeTube Downloader API is running");
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
