import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { execFile } from "child_process";
import util from "util";
import axios from "axios";
import dotenv from "dotenv";
import { URL } from "url";

dotenv.config();
const app = express();
const execFileAsync = util.promisify(execFile);

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
// Optional API key to limit use (set API_KEY env var for production)
const API_KEY = process.env.API_KEY || null;
// Optional Redis URL (redis://...)
const REDIS_URL = process.env.REDIS_URL || null;
const ENABLE_CACHING = !!REDIS_URL;

// ---------- Optional Redis setup ----------
let redis = null;
if (ENABLE_CACHING) {
  const IORedis = await import("ioredis");
  redis = new IORedis.default(REDIS_URL);
  redis.on("error", (e) => console.error("Redis error:", e));
}

// ---------- Middleware ----------
app.use(helmet());
app.use(express.json());
app.use(morgan("combined"));

// CORS - restrict to your app origin(s) in production
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // allow non-browser clients (curl)
    if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    return callback(new Error("CORS policy: This origin is not allowed"), false);
  }
}));

// Rate limit - basic protection
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // max requests per IP per window
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// ---------- Helpers ----------
function humanFileSize(bytes) {
  if (!bytes || isNaN(bytes)) return "Unknown";
  const thresh = 1024;
  if (Math.abs(bytes) < thresh) return bytes + " B";
  const units = ["KB","MB","GB","TB"];
  let u = -1;
  do {
    bytes /= thresh;
    ++u;
  } while(Math.abs(bytes) >= thresh && u < units.length - 1);
  return bytes.toFixed(1) + " " + units[u];
}

// get HEAD Content-Length; returns bytes or null
async function getContentLength(url) {
  try {
    const resp = await axios.head(url, { timeout: 10_000, maxRedirects: 5 });
    const len = resp.headers["content-length"];
    return len ? parseInt(len, 10) : null;
  } catch (e) {
    // HEAD can fail with some CDNs; try GET with Range=bytes=0-0 as fallback
    try {
      const resp = await axios.get(url, {
        timeout: 15_000,
        maxRedirects: 5,
        responseType: "stream",
        headers: { Range: "bytes=0-0" }
      });
      const len = resp.headers["content-range"] || resp.headers["content-length"];
      if (len) {
        // content-range: bytes 0-0/12345
        const m = String(len).match(/\/(\d+)$/);
        if (m) return parseInt(m[1], 10);
        return parseInt(len, 10) || null;
      }
    } catch (err) {
      return null;
    }
  }
  return null;
}

// Normalize format objects and dedupe by URL
function normalizeAndFilterFormats(rawFormats) {
  const out = [];
  const seen = new Set();
  for (const f of rawFormats) {
    if (!f || !f.url) continue;
    // prefer http(s) only
    try {
      const parsed = new URL(f.url);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
    } catch (_) {
      continue;
    }
    // dedupe
    if (seen.has(f.url)) continue;
    seen.add(f.url);

    let type = "video";
    if (f.vcodec === "none" || (f.acodec && !f.vcodec)) type = "audio";
    if (f.format && /audio/i.test(f.format)) type = "audio";
    if (f.ext && ["jpg","jpeg","png","webp","gif"].includes(String(f.ext).toLowerCase())) type = "image";

    const height = f.height || f.tbr || f.format_note || "";
    const labelParts = [];
    if (f.format_note) labelParts.push(String(f.format_note).trim());
    if (f.height) labelParts.push(String(f.height) + "p");
    if (!labelParts.length && f.format) labelParts.push(f.format);

    const label = labelParts.join(" ") || (f.ext ? `${f.ext.toUpperCase()}` : "Unknown");

    out.push({
      label,
      url: f.url,
      type,
      filesize: f.filesize || f.filesize_approx || null,
      ext: f.ext || null,
      width: f.width || null,
      height: f.height || null,
      tbr: f.tbr || null,
      format_id: f.format_id || null
    });
  }
  return out;
}

// ---------- API: /api/extract ----------
app.get("/api/extract", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "Missing url parameter" });

  // API key check (optional)
  if (API_KEY) {
    const key = req.headers["x-api-key"] || req.query.apikey;
    if (!key || key !== API_KEY) {
      return res.status(401).json({ error: "Missing or invalid API key" });
    }
  }

  // Basic validation
  try {
    new URL(targetUrl);
  } catch (e) {
    return res.status(400).json({ error: "Invalid url" });
  }

  // Try cache first
  const cacheKey = `extract:${targetUrl}`;
  if (ENABLE_CACHING && redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return res.json(parsed);
      }
    } catch (e) {
      console.error("Redis get error:", e);
    }
  }

  try {
    // Run yt-dlp to get JSON metadata (-j). Use --no-warnings to keep stdout clean.
    // Increase timeout if needed for slow sites.
    const args = ["-j", "--no-warnings", targetUrl];
    // execFile runs the program directly (safer than exec with shell)
    const { stdout } = await execFileAsync("yt-dlp", args, { maxBuffer: 10 * 1024 * 1024 });

    // sometimes yt-dlp outputs multiple json lines (playlist); parse first valid JSON
    let meta = null;
    try {
      meta = JSON.parse(stdout);
    } catch (e) {
      // Some sites return multiple JSON objects; try to find first
      const firstLine = stdout.split(/\r?\n/).find(l => l.trim().startsWith("{"));
      if (firstLine) meta = JSON.parse(firstLine);
      else throw e;
    }

    const rawFormats = meta.formats || [];
    let formats = normalizeAndFilterFormats(rawFormats);

    // For items missing filesize, try HEAD requests concurrently (but cap concurrency)
    const toCheck = formats.filter(f => !f.filesize);
    const concurrency = 6;
    for (let i = 0; i < toCheck.length; i += concurrency) {
      const slice = toCheck.slice(i, i + concurrency);
      await Promise.all(slice.map(async (f) => {
        try {
          const len = await getContentLength(f.url);
          if (len) f.filesize = len;
        } catch (_) { /* ignore */ }
      }));
    }

    // Map to response schema expected by your app
    const mapped = formats.map(f => ({
      label: f.label || (f.height ? `${f.height}p` : (f.ext || "file")),
      size: humanFileSize(f.filesize),
      url: f.url,
      type: f.type || "video"
    }));

    // Optionally sort: audio last, images separate
    mapped.sort((a,b) => {
      if (a.type === b.type) {
        // try prefer higher size (higher quality) first if size numeric
        const as = parseFloat(a.size) || 0;
        const bs = parseFloat(b.size) || 0;
        return bs - as;
      }
      if (a.type === "video") return -1;
      if (b.type === "video") return 1;
      if (a.type === "audio") return -1;
      return 1;
    });

    const payload = { formats: mapped };

    // store in cache for a short time (e.g., 5 minutes)
    if (ENABLE_CACHING && redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(payload), "EX", 300); // 300s
      } catch (e) { console.error("Redis set error:", e); }
    }

    return res.json(payload);
  } catch (err) {
    console.error("extract error:", err?.stderr || err);
    return res.status(500).json({ error: "Failed to extract formats" });
  }
});

// Root
app.get("/", (req, res) => res.send("Universal Extractor API is running"));

// Start
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
