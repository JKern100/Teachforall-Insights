require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Password protection middleware
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  const password = process.env.APP_PASSWORD;
  
  if (!password) {
    return next(); // No password set, skip protection
  }
  
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm=Teach For All Insights');
    return res.status(401).send('Authentication required');
  }
  
  const base64Credentials = auth.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, userPassword] = credentials.split(':');
  
  if (userPassword !== password) {
    return res.status(401).send('Invalid credentials');
  }
  
  next();
});

app.use(express.static('public', { index: false }));

// Constants (from your original code)
const MODEL_SYNTH = "gemini-2.0-flash";
const PREVIEW_LEN = 700;
const ANSWER_LEN = 1800;
const TEMPERATURE = 0.2;
const MAX_CONTENT_CHECKS = 200;
const MAX_TRANSCRIPT_CHARS = 120000;
const MAX_CONVERSATION_HISTORY = 20; // Keep last 20 messages

// Google Drive integration
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '';

let _driveAuthClient = null;

function getGoogleCredentials() {
  // Option 1: JSON key file path (simplest, works locally and on Vercel)
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (keyFile) {
    try {
      return JSON.parse(require('fs').readFileSync(keyFile, 'utf8'));
    } catch (e) {
      console.error('Failed to read key file:', e.message);
    }
  }

  // Option 2: Full JSON in env var (for Vercel)
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  if (keyJson) {
    try {
      return JSON.parse(keyJson);
    } catch (e) {
      console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY_JSON:', e.message);
    }
  }

  // Option 3: Individual env vars
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';
  const key = rawKey.replace(/\\n/g, '\n').trim();
  if (email && key && key.includes('PRIVATE KEY')) {
    return { client_email: email, private_key: key };
  }

  return null;
}

async function getDriveClient() {
  const creds = getGoogleCredentials();
  if (!creds) return null;

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  const client = await auth.getClient();
  return google.drive({ version: 'v3', auth: client });
}

async function gdriveListFiles(folderId, pageToken) {
  const drive = await getDriveClient();
  if (!drive) throw new Error('Google Drive not configured');
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
    pageSize: 200,
    orderBy: 'modifiedTime desc',
    pageToken: pageToken || undefined
  });
  return res.data;
}

async function gdriveListAllFiles(folderId, depth = 0) {
  if (depth > 3) return [];
  let allFiles = [];
  let pageToken = null;
  do {
    const data = await gdriveListFiles(folderId, pageToken);
    const files = data.files || [];
    for (const f of files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const subFiles = await gdriveListAllFiles(f.id, depth + 1);
        allFiles = allFiles.concat(subFiles);
      } else {
        allFiles.push(f);
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return allFiles;
}

async function gdriveReadFile(fileId) {
  const drive = await getDriveClient();
  if (!drive) throw new Error('Google Drive not configured');
  
  const meta = await drive.files.get({ fileId, fields: 'mimeType' });
  const mimeType = meta.data.mimeType;
  
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
    return typeof res.data === 'string' ? res.data : String(res.data || '');
  }
  
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
  return typeof res.data === 'string' ? res.data : String(res.data || '');
}

function useGoogleDrive() {
  return !!(GDRIVE_FOLDER_ID && getGoogleCredentials());
}

// In-memory conversation storage (keyed by session ID)
const conversations = new Map();

function getConversation(sessionId) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, { history: [], context: null });
  }
  return conversations.get(sessionId);
}

function clearConversation(sessionId) {
  conversations.delete(sessionId);
  return { cleared: true };
}

// Supabase config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Utility functions
function clip(s, n) {
  s = (s || "").toString();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateInput(s, isEndExclusive) {
  s = (s || "").trim();
  if (!s) return null;

  // MM/DD/YYYY
  var m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    var y = +m[3], mo = +m[1] - 1, d = +m[2];
    var dt = new Date(Date.UTC(y, mo, d + (isEndExclusive ? 1 : 0)));
    return dt.toISOString();
  }

  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    var y2 = +m[1], mo2 = +m[2] - 1, d2 = +m[3];
    var dt2 = new Date(Date.UTC(y2, mo2, d2 + (isEndExclusive ? 1 : 0)));
    return dt2.toISOString();
  }

  return null;
}

// Gemini API call with conversation history support
async function gemini(model, userText, conversationHistory = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in environment variables.");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  // Build contents array with conversation history
  const contents = [];
  
  // Add conversation history
  for (const msg of conversationHistory) {
    contents.push({ role: msg.role, parts: [{ text: msg.text }] });
  }
  
  // Add current user message
  contents.push({ role: "user", parts: [{ text: userText }] });
  
  const payload = {
    contents,
    generationConfig: { temperature: TEMPERATURE }
  };

  try {
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    const text = (((response.data.candidates || [])[0] || {}).content || {}).parts?.[0]?.text || "";
    if (!text.trim()) {
      const meta = response.data.promptFeedback || response.data.safetyRatings || response.data;
      throw new Error("Gemini API error: " + JSON.stringify(meta));
    }
    return text.trim();
  } catch (error) {
    if (error.response) {
      throw new Error(`Gemini HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

// Supabase fetch
async function fetchFromSupabase(params) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase credentials not configured");
  }

  let base = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/meetings?select=*";
  const parts = [];

  if (params.from) parts.push("date=gte." + encodeURIComponent(params.from));
  if (params.to) parts.push("date=lte." + encodeURIComponent(params.to));

  if (params.type && params.type !== "all") {
    parts.push("type=eq." + encodeURIComponent(params.type));
  }

  if (params.countries) {
    const list = params.countries.split(",").map(s => s.trim()).filter(Boolean);
    if (list.length) {
      const ors = list.map(c => "countries.ilike.*" + encodeURIComponent(c) + "*").join(",");
      parts.push("or=(" + ors + ")");
    }
  }

  if (params.topic) {
    const t = encodeURIComponent(params.topic);
    parts.push("or=(headline.ilike.*" + t + "*,summary.ilike.*" + t + "*)");
  }

  parts.push("order=date.desc");
  parts.push("limit=" + (params.limit || 100));

  const restUrl = base + (parts.length ? ("&" + parts.join("&")) : "");

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: "Bearer " + SUPABASE_KEY,
    Accept: "application/json"
  };

  try {
    const response = await axios.get(restUrl, { headers });
    const arr = response.data || [];

    const rows = arr.map(r => ({
      id: r.id,
      title: r.headline || r.title || "(untitled)",
      date_iso: r.date || (r.created_at ? String(r.created_at).slice(0, 10) : ""),
      summary_text: r.summary || "",
      countries: r.countries || "",
      type: r.type || "",
      message_id: r.message_id || r.messageId || r.outlook_message_id || r.outlookMessageId || "",
      file_path: r.file_path || r.filePath || r.transcript_path || r.transcriptPath || r.transcript_file || r.transcriptFile || "",
      source_url: r.source_url || r.sourceUrl || r.url || r.link || ""
    }));

    const filters = [
      params.from && `from ${params.from}`,
      params.to && `to ${params.to}`,
      (params.type && params.type !== "all") && `type=${params.type}`,
      params.countries && `countries=${params.countries}`,
      params.topic && `topic=${params.topic}`,
      `limit=${params.limit || 100}`
    ].filter(Boolean).join(" · ");

    const sqlApprox =
`select * from public.meetings
where ${params.from ? "date >= '" + params.from + "'" : "true"}
${params.to ? " and date <= '" + params.to + "'" : ""}
${(params.type && params.type !== "all") ? " and type = '" + params.type + "'" : ""}
${params.countries ? " and (" + params.countries.split(",").map(s => "countries ilike '%" + s.trim() + "%'").join(" or ") + ")" : ""}
${params.topic ? " and (headline ilike '%" + params.topic + "%' or summary ilike '%" + params.topic + "%')" : ""}
order by date desc
limit ${params.limit || 100};`;

    return { rows, restUrl, sqlApprox, filters };
  } catch (error) {
    if (error.response) {
      throw new Error(`Supabase HTTP ${error.response.status}: ${error.response.data?.substring(0, 300)}`);
    }
    throw error;
  }
}

// Build prompt
function buildPromptSimple(question, items, style) {
  const brevity = (style === "short") ? "Keep the answer concise (≤ 150 words)." :
    "Be reasonably thorough (≤ " + ANSWER_LEN + " characters).";
  
  const itemsBlock = items.map((it, i) =>
    `[${i + 1}] ${it.title} — ${it.date_iso}${it.countries ? " — " + it.countries : ""}\n` +
    clip(String(it.summary_text).replace(/\s+/g, " "), PREVIEW_LEN)
  ).join("\n\n");

  return [
    "Answer the user's question using ONLY the Items below.",
    "",
    "FORMATTING RULES (MUST FOLLOW):",
    "- Return clean HTML only (no Markdown fences or code blocks)",
    "- ALWAYS use bullet points (<ul><li>) for lists of items or updates",
    "- ALWAYS use <strong> tags to bold key names, dates, topics, and important terms",
    "- Use <h4> for section headers when organizing multiple topics",
    "- Keep paragraphs short and scannable",
    "- When citing sources, use [n] format with the number in bold: <strong>[1]</strong>",
    "- Example format:",
    "  <h4>Topic Name</h4>",
    "  <ul>",
    "    <li><strong>Key Person</strong> discussed <strong>Important Topic</strong> on <strong>Date</strong> [1]</li>",
    "  </ul>",
    "",
    "CONTEXT:",
    "My name is Jeff Kern, and I am a Network Engagement Lead at Teach For All. Any references to 'Jeff' refer to me. I manage relationships with partner organizations in the European region (Ukraine, Latvia, Slovakia, Italy, Spain, Portugal) and early-stage partners (Albania, Moldova). I work with CEOs to deepen network engagement and foster collaborative learning.",
    "",
    brevity,
    "",
    "Question:", (question || "").trim(),
    "",
    "Items:", itemsBlock,
    "",
    "Remember: Use bullets and bold formatting. Make it easy to scan."
  ].join("\n");
}

// Add note to meetings
async function addNoteToMeetings(p) {
  const url = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/meetings";

  const rec = {
    type: "Note",
    date: p.date || today(),
    countries: p.countries || "",
    headline: ((p.headline || p.note_headline || "").toString().trim()) ||
      (p.author ? `Note by ${p.author}` : "Note"),
    summary: p.note || ""
  };

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
  };

  try {
    const response = await axios.post(url, rec, { headers });
    return { table: "meetings", inserted: Array.isArray(response.data) ? response.data.length : 1, row: response.data[0] || null };
  } catch (error) {
    if (error.response) {
      throw new Error(`Supabase insert HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

// Local file system functions for transcripts
const NAME_TIME_REGEX = /^(\d{4})[-/](\d{2})[-/](\d{2})[ _T](\d{2})[.:](\d{2})[.:](\d{2})\b/;

function parseNameTimestampMs(name) {
  name = String(name || "");
  const m = name.match(NAME_TIME_REGEX);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const hh = Number(m[4]), mm = Number(m[5]), ss = Number(m[6]);
  return Date.UTC(y, mo - 1, d, hh, mm, ss);
}

function makePreview(text, maxLen) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > maxLen ? t.slice(0, maxLen - 1) + "…" : t;
}

function norm(s) { return String(s || "").toLowerCase(); }

function anyKeywordHit(haystack, kwsLower) {
  if (!kwsLower || !kwsLower.length) return true;
  const h = norm(haystack);
  return kwsLower.some(w => h.indexOf(w) >= 0);
}

function hasAllowedTranscriptExt(name) {
  const n = String(name || '').toLowerCase();
  return n.endsWith('.txt') || n.endsWith('.vtt') || n.endsWith('.srt');
}

// Find transcripts (Google Drive or local folder)
async function findTranscripts(p) {
  if (useGoogleDrive()) {
    return findTranscriptsGDrive(p);
  }
  return findTranscriptsLocal(p);
}

async function findTranscriptsGDrive(p) {
  const limit = Math.min(Number(p.limit || 10), 50);
  const fromIso = parseDateInput(p.from, false);
  const toIso = parseDateInput(p.to, true);
  const fromMs = fromIso ? Date.parse(fromIso) : null;
  const toMs = toIso ? Date.parse(toIso) : null;

  const kws = String(p.keywords || "")
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toLowerCase());

  try {
    const allFiles = await gdriveListAllFiles(GDRIVE_FOLDER_ID);
    
    const transcriptFiles = allFiles.filter(f => {
      const name = String(f.name || '').toLowerCase();
      return name.endsWith('.txt') || name.endsWith('.vtt') || name.endsWith('.srt') ||
             f.mimeType === 'application/vnd.google-apps.document';
    });

    const results = [];
    let checks = 0;

    for (const f of transcriptFiles) {
      if (results.length >= limit) break;

      const nameMs = parseNameTimestampMs(f.name) || (f.modifiedTime ? Date.parse(f.modifiedTime) : Date.now());

      if (fromMs && nameMs < fromMs) continue;
      if (toMs && nameMs >= toMs) continue;

      let hit = kws.length ? anyKeywordHit(f.name, kws) : true;
      let preview = "";

      if (!hit && kws.length && checks < MAX_CONTENT_CHECKS) {
        try {
          const body = await gdriveReadFile(f.id);
          checks++;
          hit = anyKeywordHit(body, kws);
          if (hit) preview = makePreview(body, 500);
        } catch (err) {
          // Skip files that can't be read
        }
      }

      if (hit) {
        results.push({
          id: 'gdrive:' + f.id,
          name: f.name,
          mimeType: f.mimeType || 'text/plain',
          modified: f.modifiedTime || new Date(nameMs).toISOString(),
          link: `https://drive.google.com/file/d/${f.id}/view`,
          preview: preview
        });
      }
    }

    results.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
    return { ok: true, results: results.slice(0, limit) };
  } catch (err) {
    console.error('Google Drive error:', err.message);
    return { ok: false, error: "Google Drive error: " + err.message };
  }
}

async function findTranscriptsLocal(p) {
  const limit = Math.min(Number(p.limit || 10), 50);
  const fromIso = parseDateInput(p.from, false);
  const toIso = parseDateInput(p.to, true);
  const fromMs = fromIso ? Date.parse(fromIso) : null;
  const toMs = toIso ? Date.parse(toIso) : null;

  const kws = String(p.keywords || "")
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toLowerCase());

  const transcriptsFolder = process.env.TRANSCRIPTS_FOLDER || './transcripts';
  
  if (!await fs.pathExists(transcriptsFolder)) {
    return { ok: false, error: "Transcripts folder not found: " + transcriptsFolder };
  }

  const results = [];
  let checks = 0;

  async function scanFolder(folderPath, depth = 0) {
    if (depth > 3 || results.length >= limit) return;

    const items = await fs.readdir(folderPath);
    
    for (const item of items) {
      if (results.length >= limit) break;
      
      const itemPath = path.join(folderPath, item);
      const stats = await fs.stat(itemPath);
      
      if (stats.isDirectory()) {
        await scanFolder(itemPath, depth + 1);
        continue;
      }

      if (!hasAllowedTranscriptExt(item)) continue;

      const nameMs = parseNameTimestampMs(item) || stats.mtime.getTime();
      
      if (fromMs && nameMs < fromMs) continue;
      if (toMs && nameMs >= toMs) continue;

      let hit = kws.length ? anyKeywordHit(item, kws) : true;
      let preview = "";

      if (!hit && kws.length && checks < MAX_CONTENT_CHECKS) {
        try {
          const body = await fs.readFile(itemPath, 'utf8');
          checks++;
          hit = anyKeywordHit(body, kws);
          if (hit) preview = makePreview(body, 500);
        } catch (err) {
          // Skip files that can't be read
        }
      }

      if (hit) {
        results.push({
          id: itemPath,
          name: item,
          mimeType: 'text/plain',
          modified: new Date(nameMs).toISOString(),
          link: `file://${itemPath}`,
          preview: preview
        });
      }
    }
  }

  await scanFolder(transcriptsFolder);
  
  results.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
  return { ok: true, results: results.slice(0, limit) };
}

// Transcript conversation storage (keyed by session ID)
const transcriptConversations = new Map();

function getTranscriptConversation(sessionId) {
  if (!transcriptConversations.has(sessionId)) {
    transcriptConversations.set(sessionId, { history: [], transcriptId: null });
  }
  return transcriptConversations.get(sessionId);
}

function clearTranscriptConversation(sessionId) {
  transcriptConversations.delete(sessionId);
  return { cleared: true };
}

// Ask about transcript (with conversation history)
async function askTranscript(p) {
  const id = String(p.id || "").trim();
  const q = String(p.question || "").trim();
  const sessionId = String(p.sessionId || "tr_default").trim();
  
  if (!id) return { ok: false, error: "Missing transcript id" };
  if (!q) return { ok: false, error: "Missing question" };

  const conversation = getTranscriptConversation(sessionId);
  const isNewTranscript = conversation.transcriptId !== id;

  let raw;
  try {
    if (id.startsWith('gdrive:')) {
      const fileId = id.replace('gdrive:', '');
      raw = await gdriveReadFile(fileId) || "";
    } else {
      raw = await fs.readFile(id, 'utf8') || "";
    }
  } catch (e) {
    return { ok: false, error: "Failed to read transcript: " + e.message };
  }
  
  if (!raw.trim()) return { ok: false, error: "Transcript is empty" };

  const text = raw.replace(/\r/g, "");
  const truncatedText = text.length > MAX_TRANSCRIPT_CHARS ? 
    text.slice(text.length - MAX_TRANSCRIPT_CHARS) : text;

  let prompt;
  if (isNewTranscript || conversation.history.length === 0) {
    // First message or different transcript - include full context
    prompt = [
      "You answer questions about a meeting transcript.",
      "",
      "FORMATTING RULES (MUST FOLLOW):",
      "- Return clean HTML only (no Markdown fences or code blocks)",
      "- ALWAYS use bullet points (<ul><li>) for lists",
      "- ALWAYS use <strong> tags to bold key names, dates, topics, and important terms",
      "- Use <h4> for section headers when organizing multiple topics",
      "- Keep paragraphs short and scannable",
      "- Example format:",
      "  <h4>Topic Name</h4>",
      "  <ul>",
      "    <li><strong>Person Name</strong> discussed <strong>Topic</strong></li>",
      "  </ul>",
      "",
      "If not clearly in the transcript, say so briefly.",
      "",
      "CONTEXT: My name is Jeff Kern, Network Engagement Lead at Teach For All. I manage European region partners (Ukraine, Latvia, Slovakia, Italy, Spain, Portugal) and early-stage partners (Albania, Moldova).",
      "",
      "Question:", q,
      "",
      "Transcript:", '"""', truncatedText, '"""',
      "",
      "Remember: Use bullets and bold formatting. Make it easy to scan."
    ].join("\n");

    conversation.transcriptId = id;
    conversation.history = [];
  } else {
    // Follow-up message - just the question
    prompt = `Follow-up question about the same transcript:\n\n${q}\n\nRemember: Return clean HTML with bullets and bold formatting. Make it easy to scan.`;
  }

  const answer = await gemini(MODEL_SYNTH, prompt, conversation.history);

  // Store in conversation history
  conversation.history.push({ role: "user", text: prompt });
  conversation.history.push({ role: "model", text: answer });

  // Trim history if too long
  if (conversation.history.length > MAX_CONVERSATION_HISTORY * 2) {
    conversation.history = conversation.history.slice(-MAX_CONVERSATION_HISTORY * 2);
  }

  return { 
    ok: true, 
    answer,
    conversationLength: conversation.history.length / 2,
    isNewConversation: isNewTranscript || conversation.history.length === 2
  };
}

// API Routes
app.get('/api', async (req, res) => {
  try {
    const action = (req.query.action || "ask").toLowerCase();

    if (action === "findtranscripts") {
      const result = await findTranscripts(req.query);
      return res.json(result);
    }

    if (action === "asktranscript") {
      const result = await askTranscript(req.query);
      return res.json(result);
    }

    if (action === "addnote") {
      const result = await addNoteToMeetings(req.query);
      return res.json({ ok: true, result });
    }

    if (action === "getreports") {
      const params = {
        from: req.query.from || "",
        to: req.query.to || "",
        type: "Report",
        limit: 50
      };
      const fetched = await fetchFromSupabase(params);
      return res.json({ ok: true, reports: fetched.rows });
    }

    if (action === "clearconversation") {
      const sessionId = req.query.sessionId || "default";
      clearConversation(sessionId);
      return res.json({ ok: true, message: "Conversation cleared" });
    }

    if (action === "cleartranscriptconversation") {
      const sessionId = req.query.sessionId || "tr_default";
      clearTranscriptConversation(sessionId);
      return res.json({ ok: true, message: "Transcript conversation cleared" });
    }

    if (action === "ask") {
      const sessionId = req.query.sessionId || "default";
      const conversation = getConversation(sessionId);
      
      const params = {
        from: req.query.from || "",
        to: req.query.to || "",
        type: req.query.type || "all",
        countries: req.query.countries || "",
        topic: req.query.topic || "",
        limit: Number(req.query.limit || 100),
        style: req.query.style || "normal",
        question: req.query.question || req.query.q || ""
      };
      
      const fetched = await fetchFromSupabase(params);
      
      // Build system context with data (only on first message or when filters change)
      const filtersKey = JSON.stringify({ from: params.from, to: params.to, type: params.type, countries: params.countries, topic: params.topic });
      const needsNewContext = conversation.context !== filtersKey || conversation.history.length === 0;
      
      let prompt;
      if (needsNewContext) {
        // First message or filters changed - include full context
        prompt = buildPromptSimple(params.question, fetched.rows, params.style);
        conversation.context = filtersKey;
        // Clear old history when context changes
        conversation.history = [];
      } else {
        // Follow-up message - just the question with reference to previous context
        prompt = `Follow-up question (use the same data context from our conversation):\n\n${params.question}\n\nRemember to return clean HTML and cite sources using [n] format if relevant.`;
      }
      
      // Get answer with conversation history
      const answer = await gemini(MODEL_SYNTH, prompt, conversation.history);
      
      // Store in conversation history
      conversation.history.push({ role: "user", text: prompt });
      conversation.history.push({ role: "model", text: answer });
      
      // Trim history if too long
      if (conversation.history.length > MAX_CONVERSATION_HISTORY * 2) {
        conversation.history = conversation.history.slice(-MAX_CONVERSATION_HISTORY * 2);
      }
      
      const sources = fetched.rows.map(r => ({ 
        title: r.title, 
        date: r.date_iso, 
        type: r.type || "", 
        countries: r.countries || "",
        message_id: r.message_id || "",
        file_path: r.file_path || "",
        source_url: r.source_url || ""
      }));
      
      return res.json({ 
        ok: true, 
        filters: fetched.filters, 
        answer, 
        sources,
        conversationLength: conversation.history.length / 2,
        isNewConversation: needsNewContext,
        debug: { rest: fetched.restUrl, sql_approx: fetched.sqlApprox, prompt } 
      });
    }

    return res.json({ ok: false, error: `Unknown action "${action}"` });
  } catch (err) {
    console.error('API Error:', err);
    return res.json({ ok: false, error: String(err) });
  }
});

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Teach For All Insight server running on http://localhost:${PORT}`);
  console.log(`📁 Transcripts: ${useGoogleDrive() ? 'Google Drive (folder ' + GDRIVE_FOLDER_ID + ')' : (process.env.TRANSCRIPTS_FOLDER || './transcripts')}`);
  console.log(`🗄️  Supabase URL: ${SUPABASE_URL || 'Not configured'}`);
  console.log(`🤖 Gemini API: ${process.env.GEMINI_API_KEY ? 'Configured' : 'Not configured'}`);
});
