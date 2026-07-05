import { GROQ_API_KEY, GROQ_MODEL } from "./config.js";

async function askGroq(systemPrompt, userPrompt) {
  if (!GROQ_API_KEY || GROQ_API_KEY.startsWith("YOUR_")) {
    return null; // not configured — callers fall back to a local summary
  }
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 220,
        temperature: 0.6
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error("Groq request failed", e);
    return null;
  }
}

// Builds a short natural-language insight from raw sales/expense numbers.
export async function generateInsight({ businessName, todaySales, weekSales, lastWeekSales, topProduct, lowStock }) {
  const system = "You are a concise business analyst assistant embedded in a small-business dashboard called SmolBIZ. Reply with 2-3 short sentences, plain language, no markdown, no preamble.";
  const change = lastWeekSales > 0 ? (((weekSales - lastWeekSales) / lastWeekSales) * 100).toFixed(0) : null;
  const user = `Business: ${businessName}. Today's sales: $${todaySales.toFixed(2)}. This week's sales: $${weekSales.toFixed(2)}. Last week: $${lastWeekSales.toFixed(2)}. Top product: ${topProduct || "n/a"}. Low stock items: ${lowStock || 0}. Write a short insight summary mentioning the week-over-week trend and one actionable suggestion.`;

  const aiText = await askGroq(system, user);
  if (aiText) return aiText;

  // local fallback if no Groq key configured yet
  let trend = change === null ? "not enough history yet to compare weeks." :
    change >= 0 ? `sales are up ${change}% versus last week.` : `sales are down ${Math.abs(change)}% versus last week.`;
  return `Today's sales are ${"$" + todaySales.toFixed(2)}, and ${trend}${topProduct ? ` Your top seller is ${topProduct}.` : ""}${lowStock ? ` ${lowStock} product${lowStock > 1 ? "s are" : " is"} running low on stock.` : ""}`;
}

// Formats a Date as an ISO-8601 string using the LOCAL wall-clock time and
// the browser's actual UTC offset (e.g. "2026-07-07T17:00:00+08:00"),
// instead of Date#toISOString() which converts to UTC. This matters here:
// if we tell the AI "today" is in UTC, but the person typing "5pm" obviously
// means their own local 5pm, the AI has no way to know the two are
// different — it just echoes "17:00" back thinking it's UTC. new Date(...)
// then interprets that as 17:00 UTC, which — for anyone outside UTC+0 —
// lands on the wrong hour (and sometimes the wrong day) once displayed in
// the browser's local time. Keeping everything in local time end-to-end
// avoids that mismatch entirely.
function toLocalISOWithOffset(date) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset(); // minutes local is ahead of UTC
  const sign = offsetMin >= 0 ? "+" : "-";
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`;
}

// Asks Groq to read a chat message and pull out meeting details, so phrasing
// like "next Monday", "this Friday afternoon", or "in 2 weeks" resolves to an
// exact date — the old regex parser only understood "today"/"tomorrow" + a time.
// Returns { title, when: Date } or null (either "not a meeting" or the AI call
// is unavailable, in which case the caller should fall back to parseMeetingIntent).
export async function parseMeetingWithAI(text, nowDate = new Date()) {
  const nowLocal = toLocalISOWithOffset(nowDate);
  const system = `You extract meeting/event scheduling info from a workplace chat message.
Today's date and time, for resolving relative dates, is: ${nowLocal} (this is ISO 8601, in the person's own local timezone — the trailing offset, e.g. +08:00, is that timezone, not UTC).
Reply with ONLY a compact JSON object, no markdown, no explanation, in exactly this shape:
{"isMeeting": boolean, "title": string, "isoDatetime": string|null}
- "isMeeting" is true only if the message is scheduling or mentioning a specific meeting/call/sync/standup/catch-up with a day and/or time.
- "title" is a short human title for it, e.g. "Team sync" or "Client call".
- "isoDatetime" is the resolved date+time in ISO 8601, using the exact same UTC offset shown in today's date above (e.g. end it with the same "+08:00"), never converted to UTC/"Z". Any time mentioned (like "5pm") is already in that local timezone — copy it through as-is, don't shift it.
- "isoDatetime" is null if no usable date/time was mentioned.
- Phrases like "next Monday" mean the *upcoming* Monday relative to today, never today itself even if today is a Monday.
- If no time of day is mentioned, default to 09:00.
If the message isn't about scheduling a meeting, reply {"isMeeting": false, "title": "", "isoDatetime": null}.`;

  const raw = await askGroq(system, text);
  if (!raw) return null;
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.isMeeting || !parsed.isoDatetime) return null;
    const when = new Date(parsed.isoDatetime);
    if (isNaN(when.getTime())) return null;
    return { title: parsed.title || "Meeting", when };
  } catch (e) {
    console.error("Couldn't parse Groq meeting-intent response", raw, e);
    return null;
  }
}

// Very small linear forecast used to feed the predictive chart + narrate it.
export function forecastNextPeriod(dailyTotals) {
  const n = dailyTotals.length;
  if (n < 2) return { points: dailyTotals, projected: dailyTotals };
  const xs = dailyTotals.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = dailyTotals.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (dailyTotals[i] - meanY); den += (xs[i] - meanX) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  const projected = [];
  for (let i = n; i < n + 7; i++) projected.push(Math.max(0, intercept + slope * i));
  return { slope, projected };
}
