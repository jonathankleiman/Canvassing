import fs from "node:fs/promises";
import crypto from "node:crypto";
import process from "node:process";
import { XMLParser } from "fast-xml-parser";
import nodemailer from "nodemailer";

const TIMEZONE = "America/Toronto";
const KEYWORDS = ["ShinyHunters", "Canvas", "Instructure"];
const DEFAULT_RUN_TIME_ET = "14:15";
const STATE_PATH = new URL("../data/state.json", import.meta.url);
const STATUS_PATH = new URL("../public/status.json", import.meta.url);
const USER_AGENT = "CanvasThreatMonitor/1.0 (+https://github.com/)";

const SOURCES = [
  {
    name: "Krebs on Security",
    home: "https://krebsonsecurity.com/",
    feed: "https://krebsonsecurity.com/feed/"
  },
  {
    name: "BleepingComputer",
    home: "https://www.bleepingcomputer.com/",
    feed: "https://www.bleepingcomputer.com/feed/"
  },
  {
    name: "The Record",
    home: "https://therecord.media/",
    feed: "https://therecord.media/feed"
  },
  {
    name: "EdScoop",
    home: "https://edscoop.com/",
    feed: "https://edscoop.com/feed/"
  },
  {
    name: "Spiceworks",
    home: "https://www.spiceworks.com/",
    feed: "https://www.spiceworks.com/feed/"
  },
  {
    name: "Dark Reading",
    home: "https://www.darkreading.com/",
    feed: "https://www.darkreading.com/rss.xml"
  }
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: true
});

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const now = new Date();
  const currentLocalDate = formatLocalDate(now, TIMEZONE);
  const runTimeEt = normalizeRunTime(process.env.RUN_TIME_ET || DEFAULT_RUN_TIME_ET);
  const force = process.env.MONITOR_FORCE === "true";
  const state = await readJson(STATE_PATH, {
    baselineDate: currentLocalDate,
    seen: []
  });
  state.baselineDate ||= currentLocalDate;
  state.seen ||= [];

  const runGate = shouldRunNow(now, runTimeEt, state);
  if (!force && !runGate.ok) {
    console.log(`Skipping: ${runGate.reason}`);
    return;
  }

  const seen = new Set(state.seen);
  const matches = [];
  const sourceStatus = [];

  for (const source of SOURCES) {
    try {
      const articles = await fetchFeed(source);
      const todaysArticles = articles.filter((article) => {
        if (!article.publishedAt) return false;
        const articleDate = formatLocalDate(article.publishedAt, TIMEZONE);
        return articleDate === currentLocalDate && articleDate >= state.baselineDate;
      });

      for (const article of todaysArticles) {
        const matchedTerms = matchedKeywords(article);
        const id = articleId(source, article);
        if (matchedTerms.length > 0 && !seen.has(id)) {
          matches.push({ ...article, source: source.name, sourceHome: source.home, id, matchedTerms });
        }
      }

      sourceStatus.push({
        name: source.name,
        ok: true,
        checked: articles.length,
        datedToday: todaysArticles.length
      });
    } catch (error) {
      sourceStatus.push({
        name: source.name,
        ok: false,
        checked: 0,
        datedToday: 0,
        error: error.message
      });
    }
  }

  if (matches.length > 0) {
    await sendEmail(matches, currentLocalDate);
    for (const match of matches) seen.add(match.id);
  }

  if (process.env.DRY_RUN === "true") {
    console.log("DRY_RUN enabled. State files were not updated.");
    printMatches(matches, currentLocalDate);
    return;
  }

  state.seen = Array.from(seen).slice(-500);
  state.runCount = Number(state.runCount || 0) + 1;
  state.lastRunAt = now.toISOString();
  state.lastCheckedDate = currentLocalDate;
  state.lastScheduledRunKey = force ? state.lastScheduledRunKey : runGate.key;

  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  await fs.writeFile(
    STATUS_PATH,
    `${JSON.stringify(
      {
        lastRunAt: now.toISOString(),
        checkedDate: currentLocalDate,
        baselineDate: state.baselineDate,
        timezone: TIMEZONE,
        runTimeEt,
        keywords: KEYWORDS,
        runCount: state.runCount,
        matchesSent: matches.length,
        sourceStatus,
        matchedArticles: matches.map((match) => ({
          source: match.source,
          title: match.title,
          link: match.link,
          publishedAt: match.publishedAt?.toISOString(),
          matchedTerms: match.matchedTerms
        }))
      },
      null,
      2
    )}\n`
  );

  printMatches(matches, currentLocalDate);
}

async function fetchFeed(source) {
  const response = await fetch(source.feed, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`${source.feed} returned HTTP ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
  return array(items).map((item) => normalizeItem(item));
}

function normalizeItem(item) {
  const link = normalizeLink(item.link);
  const publishedRaw = text(item.pubDate ?? item.published ?? item.updated ?? item["dc:date"]);
  const publishedAt = publishedRaw ? new Date(publishedRaw) : null;

  return {
    title: decodeHtmlEntities(text(item.title)),
    link,
    guid: decodeHtmlEntities(text(item.guid)),
    description: decodeHtmlEntities(stripHtml(text(item.description ?? item.summary ?? item["content:encoded"] ?? item.content))),
    publishedAt: publishedAt && !Number.isNaN(publishedAt.valueOf()) ? publishedAt : null
  };
}

function matchedKeywords(article) {
  const haystack = `${article.title}\n${article.description}`.toLowerCase();
  return KEYWORDS.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

function articleId(source, article) {
  const stable = [source.name, article.guid, article.link, article.title, article.publishedAt?.toISOString()]
    .filter(Boolean)
    .join("|");
  return crypto.createHash("sha256").update(stable).digest("hex");
}

async function sendEmail(matches, checkedDate) {
  const recipients = parseRecipients(process.env.ALERT_RECIPIENTS);
  if (recipients.length === 0) {
    throw new Error("ALERT_RECIPIENTS is not configured. Add it as a GitHub Actions repository variable or secret.");
  }

  const subject = `[Article monitor] ${matches.length} match${matches.length === 1 ? "" : "es"} for ${checkedDate}`;
  const textBody = renderText(matches, checkedDate);
  const htmlBody = renderHtml(matches, checkedDate);

  if (process.env.DRY_RUN === "true") {
    console.log(`DRY_RUN enabled. Would send "${subject}" to ${recipients.join(", ")}.`);
    console.log(textBody);
    return;
  }

  if (process.env.RESEND_API_KEY) {
    await sendWithResend({ recipients, subject, textBody, htmlBody });
    return;
  }

  if (process.env.SMTP_HOST) {
    await sendWithSmtp({ recipients, subject, textBody, htmlBody });
    return;
  }

  throw new Error("No email provider configured. Set RESEND_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS secrets.");
}

async function sendWithResend({ recipients, subject, textBody, htmlBody }) {
  const from = process.env.ALERT_FROM_EMAIL || "Article Monitor <onboarding@resend.dev>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject,
      text: textBody,
      html: htmlBody
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend failed with HTTP ${response.status}: ${body}`);
  }
}

async function sendWithSmtp({ recipients, subject, textBody, htmlBody }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      : undefined
  });

  await transporter.sendMail({
    from: process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER,
    to: recipients,
    subject,
    text: textBody,
    html: htmlBody
  });
}

function renderText(matches, checkedDate) {
  return [
    `Article monitor matches for ${checkedDate}`,
    "",
    ...matches.map((match) =>
      [
        `${match.source}: ${match.title}`,
        `Matched: ${match.matchedTerms.join(", ")}`,
        `Published: ${match.publishedAt?.toISOString()}`,
        `Link: ${match.link}`
      ].join("\n")
    )
  ].join("\n\n");
}

function renderHtml(matches, checkedDate) {
  const items = matches
    .map(
      (match) => `<li>
        <strong>${escapeHtml(match.source)}</strong>: <a href="${escapeHtml(match.link)}">${escapeHtml(match.title)}</a><br>
        Matched: ${escapeHtml(match.matchedTerms.join(", "))}<br>
        Published: ${escapeHtml(match.publishedAt?.toISOString() ?? "unknown")}
      </li>`
    )
    .join("");

  return `<p>Article monitor matches for ${escapeHtml(checkedDate)}.</p><ul>${items}</ul>`;
}

function printMatches(matches, currentLocalDate) {
  console.log(`Checked ${SOURCES.length} sources for ${currentLocalDate}. New matches: ${matches.length}.`);
  for (const match of matches) {
    console.log(`- ${match.source}: ${match.title} (${match.matchedTerms.join(", ")})`);
  }
}

function parseRecipients(value = "") {
  return value
    .split(/[,\n;]/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function shouldRunNow(date, runTimeEt, state) {
  const parts = localParts(date, TIMEZONE);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const targetMinutes = parseRunTimeMinutes(runTimeEt);

  if (currentMinutes < targetMinutes) {
    return {
      ok: false,
      reason: `current local time is before the ${runTimeEt} ${TIMEZONE} run target`
    };
  }

  const key = `${formatLocalDate(date, TIMEZONE)}-${runTimeEt}`;
  if (state.lastScheduledRunKey === key) {
    return {
      ok: false,
      reason: `${runTimeEt} ${TIMEZONE} run already completed for today`
    };
  }

  return { ok: true, key };
}

function normalizeRunTime(value) {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return DEFAULT_RUN_TIME_ET;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return DEFAULT_RUN_TIME_ET;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseRunTimeMinutes(value) {
  const [hour, minute] = normalizeRunTime(value).split(":").map(Number);
  return hour * 60 + minute;
}

function formatLocalDate(date, timeZone) {
  const parts = localParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });

  return Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function normalizeLink(link) {
  if (Array.isArray(link)) {
    const href = link.find((entry) => entry?.["@_href"])?.["@_href"];
    return href || text(link[0]);
  }
  if (link?.["@_href"]) return link["@_href"];
  return text(link);
}

function text(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return decodeHtmlEntities(String(value));
  if (value["#cdata"]) return decodeHtmlEntities(value["#cdata"]);
  if (value["#text"]) return decodeHtmlEntities(value["#text"]);
  return "";
}

function stripHtml(value) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function array(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
