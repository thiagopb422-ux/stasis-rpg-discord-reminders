const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_PROJECT = "stasisrpg";
const DEFAULT_TIME_ZONE = "America/Sao_Paulo";
const DEFAULT_GUILD_ID = "1019386388602425365";
const CLAIM_TTL_MS = 10 * 60 * 1000;
const PARCHMENT_EMOJI = "<:pergaminho:1166442960183885844>";
const DRAGON_EMOJI = "<:dragao:1124393908441464873>";
const DIRECT_MESSAGE_ARTWORK = "https://i.pinimg.com/originals/cd/f7/29/cdf729fcc599dee31ee6b78ed4dbb71b.gif";

const REMINDER_DEFINITIONS = [
  { hours: 18, atField: "sessionReminder18At", sentAtField: "sessionReminder18SentAt", messageField: "sessionReminder18MessageId", claimField: "sessionReminder18ClaimedAt" },
  { hours: 5, atField: "sessionReminder5At", sentAtField: "sessionReminder5SentAt", messageField: "sessionReminder5MessageId", claimField: "sessionReminder5ClaimedAt" },
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
  if (Object.hasOwn(value, "mapValue"))
    return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, nested]) => [key, decodeValue(nested)]));
  return null;
}

function decodeDocument(document) {
  return {
    id: document.name.split("/").at(-1),
    _updateTime: document.updateTime || "",
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

async function listCollectionEqual(env, token, name, field, value) {
  const response = await fetch(`${firestoreRoot(env)}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: name }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: encodeValue(value) } },
      },
    }),
  });
  if (!response.ok) throw new Error(`${name} (${field}=${value}): ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows.flatMap((row) => row.document ? [decodeDocument(row.document)] : []);
}

async function patchDocument(env, token, collectionName, id, patch, updateTime = "") {
  const params = new URLSearchParams();
  for (const key of Object.keys(patch)) params.append("updateMask.fieldPaths", key);
  if (updateTime) params.set("currentDocument.updateTime", updateTime);
  const response = await fetch(`${firestoreRoot(env)}/${collectionName}/${encodeURIComponent(id)}?${params}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, encodeValue(value)])) }),
  });
  if (!response.ok) {
    const error = new Error(`${collectionName}/${id}: ${response.status} ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return decodeDocument(await response.json());
}

async function discord(env, path, init = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
    });
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(Number(body.retry_after || 1) * 1000)));
      continue;
    }
    if (!response.ok) throw new Error(`Discord ${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }
  throw new Error("O Discord limitou as tentativas da automação.");
}

async function discordMaybe(env, path, init = {}) {
  try { return await discord(env, path, init); } catch { return null; }
}

async function sendDiscord(env, channelId, payload) {
  return discord(env, `/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify(payload) });
}

function sessionLabel(startsAt, timeZone) {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit", timeZone: timeZone || DEFAULT_TIME_ZONE,
  }).format(new Date(startsAt));
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
      description: `# <:pergaminho2:1167606503407104000> Pergaminho Encontrado\n\n${timing}\n\n${DRAGON_EMOJI} **${safe(book.nextSessionTitle || "Próxima sessão", 240)}**\n${safe(sessionLabel(book.nextSessionAt, env.TIME_ZONE), 500)}`,
      fields: [{ name: "Trama", value: safe(book.tramaTitle || "Stasis RPG", 256), inline: true }],
      ...(/^https?:\/\//i.test(String(book.nextSessionImage || "")) ? { image: { url: book.nextSessionImage } } : {}),
      footer: { text: `Stasis RPG · Aviso de ${hours} horas` },
      timestamp: new Date().toISOString(),
    }],
    ...(calendarUrl ? { components: [{ type: 1, components: [{ type: 2, style: 5, label: "Ver no Google Agenda", url: calendarUrl, emoji: { id: "1124393908441464873", name: "dragao" } }] }] } : {}),
  };
}

function reminderIsDue(book, definition, now) {
  const startsAt = new Date(book.nextSessionAt).getTime();
  const reminderAt = new Date(book[definition.atField]).getTime();
  const claimAt = new Date(book[definition.claimField]).getTime();
  return Boolean(book.nextSessionDiscordChannelId)
    && Number.isFinite(startsAt) && now < startsAt
    && Number.isFinite(reminderAt) && now >= reminderAt
    && !book[definition.sentAtField]
    && (!Number.isFinite(claimAt) || now - claimAt > CLAIM_TTL_MS);
}

export async function runReminders(env, token = null) {
  const startedAt = new Date().toISOString();
  const firebaseToken = token || await firebaseAccessToken(env);
  const books = await listCollection(env, firebaseToken, "masterBooks");
  const now = Date.now();
  let sent = 0;
  const errors = [];
  for (const book of books) {
    for (const definition of REMINDER_DEFINITIONS) {
      if (!reminderIsDue(book, definition, now)) continue;
      const claimAt = new Date().toISOString();
      try {
        await patchDocument(env, firebaseToken, "masterBooks", book.id, { [definition.claimField]: claimAt, reminderWorkerLastRunAt: claimAt });
        const message = await sendDiscord(env, book.nextSessionDiscordChannelId, reminderPayload(book, definition.hours, env));
        const sentAt = new Date().toISOString();
        await patchDocument(env, firebaseToken, "masterBooks", book.id, {
          [definition.sentAtField]: sentAt, [definition.messageField]: message.id || "", [definition.claimField]: "",
          reminderWorkerLastRunAt: sentAt, reminderWorkerLastSuccessAt: sentAt, updatedAt: sentAt,
        });
        sent += 1;
      } catch (error) {
        errors.push({ bookId: book.id, hours: definition.hours, error: String(error?.message || error) });
        await patchDocument(env, firebaseToken, "masterBooks", book.id, {
          [definition.claimField]: "", reminderWorkerLastRunAt: new Date().toISOString(), reminderWorkerLastError: String(error?.message || error).slice(0, 900),
        }).catch(() => {});
      }
    }
  }
  return { ok: errors.length === 0, startedAt, finishedAt: new Date().toISOString(), books: books.length, sent, errors };
}

function normalizeDiscordIdentity(value) {
  return String(value || "").trim().replace(/^<@!?|>$/g, "").replace(/^@/, "").replace(/#0+$/, "").normalize("NFKC").toLocaleLowerCase("pt-BR");
}

async function findGuildMember(env, target) {
  const guildId = env.DISCORD_GUILD_ID || DEFAULT_GUILD_ID;
  const raw = String(target || "").trim().replace(/^@/, "");
  const directId = raw.match(/^(?:<@!?)?(\d{16,22})>?$/)?.[1];
  if (directId) {
    const member = await discordMaybe(env, `/guilds/${guildId}/members/${directId}`);
    if (member) return member;
  }
  const query = raw.replace(/^<@!?|>$/g, "").split("#")[0].trim();
  if (!query) throw new Error("Usuário do Discord não informado.");
  const members = await discord(env, `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=25`);
  const expected = normalizeDiscordIdentity(raw);
  const exact = members.filter((member) => [
    member.user?.id, member.user?.username, member.user?.global_name, member.nick,
    member.user?.discriminator && member.user.discriminator !== "0" ? `${member.user.username}#${member.user.discriminator}` : "",
  ].some((value) => normalizeDiscordIdentity(value) === expected));
  if (exact.length === 1) return exact[0];
  if (!exact.length && members.length === 1) return members[0];
  if (exact.length > 1 || members.length > 1)
    throw new Error(`Mais de um membro corresponde a “${safe(raw, 80)}”. Informe o @usuário exato ou ID do Discord.`);
  throw new Error(`O usuário “${safe(raw, 80)}” não foi encontrado no servidor Stasis RPG.`);
}

function normalizeDirectLinks(value) {
  if (!Array.isArray(value)) return [];
  const links = [];
  for (const item of value) {
    const label = String(item?.label || "").trim().slice(0, 80);
    const rawUrl = String(item?.url || "").trim();
    if (!label || !rawUrl) continue;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      links.push({ label, url: parsed.toString().slice(0, 512), emoji: String(item?.emoji || "").trim().slice(0, 120) });
    } catch { /* Um link inválido não bloqueia os demais. */ }
    if (links.length === 5) break;
  }
  return links;
}

export function resolveButtonEmoji(value, guildEmojis = []) {
  const raw = String(value || "").trim();
  const custom = raw.match(/^<(a?):([A-Za-z0-9_~]{2,32}):(\d{16,22})>$/);
  if (custom) return { id: custom[3], name: custom[2], animated: custom[1] === "a" };
  const named = raw.match(/^:([A-Za-z0-9_~]{2,32}):$/)?.[1];
  if (named) {
    const found = guildEmojis.find((emoji) => String(emoji.name || "").toLocaleLowerCase("pt-BR") === named.toLocaleLowerCase("pt-BR"));
    if (found) return { id: found.id, name: found.name, animated: Boolean(found.animated) };
  }
  if (raw && !named && raw.length <= 32 && !/[<>\r\n]/.test(raw)) return { name: raw };
  return { name: "🔗" };
}

export function directNotificationPayload(notification, guildEmojis = []) {
  const links = normalizeDirectLinks(notification.links);
  return {
    content: `${PARCHMENT_EMOJI} **Stasis RPG - Mensagem**`,
    embeds: [{
      color: 0x9d6aba,
      title: `${DRAGON_EMOJI} ${safe(notification.reason, 180)}`,
      description: safe(notification.details, 1800),
      fields: [{ name: "Referência", value: safe(notification.subject, 160), inline: false }],
      image: { url: DIRECT_MESSAGE_ARTWORK },
      footer: { text: "Stasis RPG · Comunicação oficial" },
      timestamp: new Date().toISOString(),
    }],
    ...(links.length ? { components: [{ type: 1, components: links.map((link) => ({
      type: 2, style: 5, label: safe(link.label, 80), emoji: resolveButtonEmoji(link.emoji, guildEmojis), url: link.url,
    })) }] } : {}),
    allowed_mentions: { parse: [] },
    nonce: notification.id,
    enforce_nonce: true,
  };
}

async function runDirectNotifications(env, token) {
  const startedAt = new Date().toISOString();
  const groups = await Promise.all([
    listCollectionEqual(env, token, "discordDirectNotifications", "status", "pending"),
    listCollectionEqual(env, token, "discordDirectNotifications", "status", "processing"),
  ]);
  const retryBefore = Date.now() - CLAIM_TTL_MS;
  const notifications = groups.flat().filter((item) => item.status === "pending" || (
    item.status === "processing" && new Date(item.claimedAt || 0).getTime() < retryBefore
  )).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const guildId = env.DISCORD_GUILD_ID || DEFAULT_GUILD_ID;
  const guildEmojis = notifications.length ? await discord(env, `/guilds/${guildId}/emojis`) : [];
  let sent = 0;
  let failed = 0;
  const deliveryFailures = [];
  const systemErrors = [];

  for (const notification of notifications) {
    const claimedAt = new Date().toISOString();
    let claimed;
    try {
      claimed = await patchDocument(env, token, "discordDirectNotifications", notification.id, {
        status: "processing", claimedAt, error: "",
      }, notification._updateTime);
    } catch (error) {
      systemErrors.push({ notificationId: notification.id, stage: "claim", error: String(error?.message || error).slice(0, 500) });
      continue;
    }
    try {
      const member = await findGuildMember(env, notification.targetDiscord);
      const directChannel = await discord(env, "/users/@me/channels", { method: "POST", body: JSON.stringify({ recipient_id: member.user.id }) });
      const message = await sendDiscord(env, directChannel.id, directNotificationPayload(notification, guildEmojis));
      await patchDocument(env, token, "discordDirectNotifications", notification.id, {
        status: "sent", processedAt: new Date().toISOString(), discordUserId: member.user.id, discordMessageId: message.id || "", error: "",
      }, claimed._updateTime);
      sent += 1;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      try {
        await patchDocument(env, token, "discordDirectNotifications", notification.id, {
          status: "failed", processedAt: new Date().toISOString(), error: message,
        });
        failed += 1;
        deliveryFailures.push({ notificationId: notification.id, error: message });
      } catch (patchError) {
        systemErrors.push({ notificationId: notification.id, stage: "failure-persist", error: String(patchError?.message || patchError).slice(0, 500) });
      }
    }
  }
  return {
    ok: systemErrors.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    inspected: groups.flat().length,
    eligible: notifications.length,
    sent,
    failed,
    deliveryFailures,
    systemErrors,
  };
}

export async function runAutomation(env) {
  const startedAt = new Date().toISOString();
  const token = await firebaseAccessToken(env);
  const reminders = await runReminders(env, token);
  const directNotifications = await runDirectNotifications(env, token);
  return {
    ok: reminders.ok && directNotifications.ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    reminders,
    directNotifications,
  };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runAutomation(env).then((result) => console.log(JSON.stringify(result))));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return json({ ok: true, service: "stasis-rpg-discord-automation", scheduler: "cloud", features: ["session-reminders", "direct-notifications"] });
    if (url.pathname === "/run" && request.headers.get("authorization") === `Bearer ${env.RUN_SECRET}`)
      return json(await runAutomation(env));
    return json({ ok: false, error: "Not found" }, 404);
  },
};
