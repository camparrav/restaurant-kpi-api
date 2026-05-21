const fs = require("fs");
const path = require("path");
const { getAccessToken } = require("./graph-auth");

const GRAPH = "https://graph.microsoft.com/v1.0";

const STATE_FILE = process.env.MONITOR_STATE_FILE
  || path.join(__dirname, "..", "monitor-state.json");

const REPLY_SYSTEM_PROMPT = `You draft email replies on behalf of the user.

Rules:
- Output ONLY the body text of the reply (no subject line, no signature block — the user has their own signature).
- Match the tone of the incoming email (formal vs casual).
- Be concise. Most replies are 2–5 sentences.
- If the email asks specific questions you cannot answer (prices, dates, internal info), insert a placeholder in brackets like [confirm pricing] so the user can fill it in.
- Never invent commitments, dates, numbers, or facts. When unsure, defer politely.
- Do not include "Subject:" or quoted history.
- Plain text only — no markdown, no HTML.`;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { processedIds: [], startedAt: new Date().toISOString() };
  }
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(s.processedIds)) s.processedIds = [];
    if (!s.startedAt) s.startedAt = new Date().toISOString();
    return s;
  } catch {
    return { processedIds: [], startedAt: new Date().toISOString() };
  }
}

function saveState(state) {
  state.processedIds = state.processedIds.slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function draftReplyWithClaude(email, anthropicKey) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.MONITOR_CLAUDE_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: REPLY_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Draft a reply to this email.

From: ${email.from}
Subject: ${email.subject}
Received: ${email.receivedAt}

---
${email.bodyText}
---

Return only the reply body text.`,
      }],
    }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`Claude API ${r.status}: ${err?.error?.message || "unknown"}`);
  }
  const data = await r.json();
  return (data.content || []).map(b => b.type === "text" ? b.text : "").join("").trim();
}

async function graphGet(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function listUnread(token, sinceIso) {
  const params = new URLSearchParams({
    $filter: `isRead eq false and receivedDateTime ge ${sinceIso}`,
    $top: "25",
    $orderby: "receivedDateTime asc",
    $select: "id,subject,from,toRecipients,receivedDateTime,bodyPreview,conversationId,isDraft",
  });
  const data = await graphGet(token, `${GRAPH}/me/mailFolders/inbox/messages?${params}`);
  return data.value || [];
}

async function getMessageBody(token, id) {
  return graphGet(token, `${GRAPH}/me/messages/${id}?$select=body,from,subject,receivedDateTime`);
}

async function createReplyDraft(token, id) {
  const r = await fetch(`${GRAPH}/me/messages/${id}/createReply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`createReply -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function patchDraftBody(token, draftId, htmlBody) {
  const r = await fetch(`${GRAPH}/me/messages/${draftId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: { contentType: "HTML", content: htmlBody } }),
  });
  if (!r.ok) throw new Error(`patch draft -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function getSelfAddress(token) {
  try {
    const d = await graphGet(token, `${GRAPH}/me?$select=mail,userPrincipalName`);
    return (d.mail || d.userPrincipalName || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function shouldSkip(msg, opts) {
  if (msg.isDraft) return "isDraft";
  const fromAddr = msg.from?.emailAddress?.address?.toLowerCase() || "";
  if (!fromAddr) return "no sender";
  if (opts.selfAddress && fromAddr === opts.selfAddress) return "self";
  const autoPatterns = [
    /no[-_.]?reply@/, /noreply@/, /do[-_.]?not[-_.]?reply@/,
    /mailer-daemon@/, /postmaster@/, /^notifications?@/, /bounces?@/,
  ];
  if (autoPatterns.some(re => re.test(fromAddr))) return "auto-sender";
  if (opts.allowList?.length && !opts.allowList.includes(fromAddr)) return "not in allow list";
  if (opts.blockList?.includes(fromAddr)) return "blocked";
  return null;
}

function buildReplyHtml(replyText, originalDraftBody) {
  const paragraphs = replyText
    .split(/\n\n+/)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const banner = `<p style="color:#666;font-size:12px;font-style:italic;border-left:3px solid #ccc;padding-left:8px;margin-bottom:12px">Draft generated automatically by inbox-monitor — review before sending.</p>`;
  return `${banner}${paragraphs}${originalDraftBody || ""}`;
}

async function pollOnce(opts) {
  const token = await getAccessToken(opts.clientId);
  const state = loadState();
  if (!state.selfAddress) state.selfAddress = await getSelfAddress(token);

  const sinceIso = state.lastPollIso || state.startedAt;
  const messages = await listUnread(token, sinceIso);

  let drafted = 0;
  for (const msg of messages) {
    if (state.processedIds.includes(msg.id)) continue;

    const skipReason = shouldSkip(msg, {
      selfAddress: state.selfAddress,
      allowList: opts.allowList,
      blockList: opts.blockList,
    });
    if (skipReason) {
      console.log(`[monitor] skip "${msg.subject}" (${skipReason})`);
      state.processedIds.push(msg.id);
      saveState(state);
      continue;
    }

    try {
      const full = await getMessageBody(token, msg.id);
      const bodyText = stripHtml(full.body?.content);
      if (!bodyText) {
        state.processedIds.push(msg.id);
        saveState(state);
        continue;
      }

      const fromAddr = msg.from?.emailAddress?.address || "";
      const fromName = msg.from?.emailAddress?.name || fromAddr;
      console.log(`[monitor] drafting reply: "${msg.subject}" from ${fromAddr}`);

      const replyText = await draftReplyWithClaude({
        from: `${fromName} <${fromAddr}>`,
        subject: msg.subject || "(no subject)",
        receivedAt: msg.receivedDateTime,
        bodyText,
      }, opts.anthropicKey);

      const draft = await createReplyDraft(token, msg.id);
      const merged = buildReplyHtml(replyText, draft.body?.content);
      await patchDraftBody(token, draft.id, merged);

      console.log(`[monitor] draft saved (conversation ${msg.conversationId})`);
      drafted++;
      state.processedIds.push(msg.id);
      saveState(state);
    } catch (err) {
      console.error(`[monitor] error on "${msg.subject}": ${err.message}`);
      // Don't mark as processed — retry next poll.
    }
  }

  state.lastPollIso = new Date().toISOString();
  saveState(state);
  return { scanned: messages.length, drafted };
}

function parseList(v) {
  return String(v || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function start({ clientId, anthropicKey }) {
  if (process.env.MONITOR_ENABLED !== "true") {
    console.log("[monitor] disabled (set MONITOR_ENABLED=true to enable)");
    return null;
  }
  if (!clientId) {
    console.warn("[monitor] OUTLOOK_CLIENT_ID not set — monitor disabled");
    return null;
  }
  if (!anthropicKey) {
    console.warn("[monitor] ANTHROPIC_API_KEY not set — monitor disabled");
    return null;
  }

  const opts = {
    clientId,
    anthropicKey,
    allowList: parseList(process.env.MONITOR_ALLOW_LIST),
    blockList: parseList(process.env.MONITOR_BLOCK_LIST),
  };
  const interval = Number(process.env.MONITOR_INTERVAL_MS || 60_000);
  console.log(`[monitor] starting (every ${interval}ms, draft-only mode)`);
  if (opts.allowList.length) console.log(`[monitor] allow list: ${opts.allowList.join(", ")}`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await pollOnce(opts);
      if (r.scanned) console.log(`[monitor] poll: scanned ${r.scanned}, drafted ${r.drafted}`);
    } catch (err) {
      console.error(`[monitor] poll error: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 5_000);
  return setInterval(tick, interval);
}

module.exports = { start, pollOnce, loadState, saveState };
