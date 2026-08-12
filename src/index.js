const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_PROJECT = "stasisrpg";
const DEFAULT_TIME_ZONE = "America/Sao_Paulo";
const CLAIM_TTL_MS = 10 * 60 * 1000;

const REMINDER_DEFINITIONS = [
  {
    hours: 18,
    atField: "sessionReminder18At",
    sentAtField: "sessionReminder18SentAt",
    messageField: "sessionReminder18MessageId",
    claimField: "sessionReminder18ClaimedAt",
  },
  {
    hours: 5,
    atField: "sessionReminder5At",
    sentAtField: "sessionReminder5SentAt",
    messageField: "sessionReminder5MessageId",
    claimField: "sessionReminder5ClaimedAt",
  },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function decodeValue(value) {
  if (!value || Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.hasOwn(value, "booleanValue")) return Boolean(value.booleanValue);
  if (Object.hasOwn(value, "timestampValue")) return value.timestampValue;
  if (Object.hasOwn(value, "arrayValue")) return (value.arrayValue.values || []).map(decodeValue);
  if (Object.hasOwn(value, "mapValue")) {
    return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, nested]) => [key, decodeValue(nested)]));
  }
  return null;
}

function decodeDocument(document) {
  return {
    id: document.name.split("/").at(-1),
    ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)])),
  };
}

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, encodeValue(nested)])) } };
}

function safe(value, max = 1000) {
  return String(value || "—").replace(/@/g, "@\u200b").slice(0, max);
}

async function firebaseAccessToken(env) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: env.FIREBASE_SERVICE_EMAIL, password: env.FIREBASE_SERVICE_PASSWORD, returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`Firebase Auth ${response.status}: ${await response.text()}`);
  return (await response.json()).idToken;
}

function firestoreRoot(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT}/databases/(default)/documents`;
}

async function listCollection(env, token, name) {
  const items = [];
  let pageToken = "";
  do {
    const response = await fetch(`${firestoreRoot(env)}/${name}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
    const page = await response.json();
    items.push(...(page.documents || []).map(decodeDocument));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return items;
}

async function patchDocument(env, token, collectionName, id, patch) {
  const masks = Object.keys(patch).map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`).join("&");
  const response = await fetch(`${firestoreRoot(env)}/${collectionName}/${encodeURIComponent(id)}?${masks}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, encodeValue(value)])) }),
  });
  if (!response.ok) throw new Error(`${collectionName}/${id}: ${response.status} ${await response.text()}`);
}

async function sendDiscord(env, channelId, payload) {
  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Discord ${response.status}: ${await response.text()}`);
  return response.json();
}

function sessionLabel(startsAt, timeZone) {
  const date = new Date(startsAt);
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timeZone || DEFAULT_TIME_ZONE,
  }).format(date);
}

function googleCalendarUrl(book, env) {
  const start = new Date(book.nextSessionAt);
  if (Number.isNaN(start.getTime())) return "";
  const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
  const googleDate = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: book.nextSessionTitle || `Sessão de ${book.tramaTitle || "Stasis RPG"}`,
    dates: `${googleDate(start)}/${googleDate(end)}`,
    details: `Trama: ${book.tramaTitle || "Stasis RPG"}\n\nAgendamento confirmado pelo Stasis RPG.`,
    ctz: env.TIME_ZONE || DEFAULT_TIME_ZONE,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function reminderPayload(book, hours, env) {
  const timing = hours === 5
    ? "**Faltam apenas 5 horas.** A jornada está prestes a recomeçar."
    : "**A próxima sessão começa em 18 horas.** Prepare sua ficha, seus dados e seus equipamentos.";
  const calendarUrl = googleCalendarUrl(book, env);
  return {
    content: "||@here||",
    allowed_mentions: { parse: ["everyone"] },
    embeds: [{
      color: 0x8f69bd,
      description: `# <:pergaminho2:1167606503407104000> Pergaminho Encontrado\n\n${timing}\n\n<:dragao:1124393908441464873> **${safe(book.nextSessionTitle || "Próxima sessão", 240)}**\n${safe(sessionLabel(book.nextSessionAt, env.TIME_ZONE), 500)}`,
      fields: [{ name: "Trama", value: safe(book.tramaTitle || "Stasis RPG", 256), inline: true }],
      ...(/^https?:\/\//i.test(String(book.nextSessionImage || "")) ? { image: { url: book.nextSessionImage } } : {}),
      footer: { text: `Stasis RPG · Aviso de ${hours} horas` },
      timestamp: new Date().toISOString(),
    }],
    ...(calendarUrl ? {
      components: [{
        type: 1,
        components: [{ type: 2, style: 5, label: "Ver no Google Agenda", url: calendarUrl, emoji: { id: "1124393908441464873", name: "dragao" } }],
      }],
    } : {}),
  };
}

function reminderIsDue(book, definition, now) {
  const startsAt = new Date(book.nextSessionAt).getTime();
  const reminderAt = new Date(book[definition.atField]).getTime();
  const claimAt = new Date(book[definition.claimField]).getTime();
  return Boolean(book.nextSessionDiscordChannelId)
    && Number.isFinite(startsAt)
    && now < startsAt
    && Number.isFinite(reminderAt)
    && now >= reminderAt
    && !book[definition.sentAtField]
    && (!Number.isFinite(claimAt) || now - claimAt > CLAIM_TTL_MS);
}

export async function runReminders(env) {
  const startedAt = new Date().toISOString();
  const token = await firebaseAccessToken(env);
  const books = await listCollection(env, token, "masterBooks");
  const now = Date.now();
  let sent = 0;
  const errors = [];

  for (const book of books) {
    for (const definition of REMINDER_DEFINITIONS) {
      if (!reminderIsDue(book, definition, now)) continue;
      const claimAt = new Date().toISOString();
      try {
        await patchDocument(env, token, "masterBooks", book.id, {
          [definition.claimField]: claimAt,
          reminderWorkerLastRunAt: claimAt,
        });
        const message = await sendDiscord(env, book.nextSessionDiscordChannelId, reminderPayload(book, definition.hours, env));
        const sentAt = new Date().toISOString();
        await patchDocument(env, token, "masterBooks", book.id, {
          [definition.sentAtField]: sentAt,
          [definition.messageField]: message.id || "",
          [definition.claimField]: "",
          reminderWorkerLastRunAt: sentAt,
          reminderWorkerLastSuccessAt: sentAt,
          updatedAt: sentAt,
        });
        sent += 1;
      } catch (error) {
        errors.push({ bookId: book.id, hours: definition.hours, error: String(error?.message || error) });
        await patchDocument(env, token, "masterBooks", book.id, {
          [definition.claimField]: "",
          reminderWorkerLastRunAt: new Date().toISOString(),
          reminderWorkerLastError: String(error?.message || error).slice(0, 900),
        }).catch(() => {});
      }
    }
  }

  return { ok: errors.length === 0, startedAt, finishedAt: new Date().toISOString(), books: books.length, sent, errors };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runReminders(env).then((result) => console.log(JSON.stringify(result))));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "stasis-rpg-discord-reminders", scheduler: "cloudflare-cron", interval: "2 minutes" });
    }
    if (url.pathname === "/run" && request.headers.get("authorization") === `Bearer ${env.RUN_SECRET}`) {
      return json(await runReminders(env));
    }
    return json({ ok: false, error: "Not found" }, 404);
  },
};
