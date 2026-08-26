import {
  DICE_COMMAND_DEFINITIONS,
  createDiceImagePath,
  diceInteractionError,
  diceInteractionPayload,
  normalizeDiceStyle,
  personalizeDiceInteractionPayload,
  renderDiceImage,
  rollDice,
  verifyDiscordInteraction,
} from "./dice.js";

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_PROJECT = "stasisrpg";
const DEFAULT_TIME_ZONE = "America/Sao_Paulo";
const DEFAULT_GUILD_ID = "1019386388602425365";
const CLAIM_TTL_MS = 10 * 60 * 1000;
const PARCHMENT_EMOJI = "<:pergaminho:1166442960183885844>";
const DRAGON_EMOJI = "<:dragao:1124393908441464873>";
const DIRECT_MESSAGE_ARTWORK = "https://i.pinimg.com/originals/cd/f7/29/cdf729fcc599dee31ee6b78ed4dbb71b.gif";
const SUBMISSION_CONFIRMATION_ARTWORK = "https://i.pinimg.com/originals/b2/4a/14/b24a14cd5109ef90223cfda09389c6e6.gif";
const SUBMISSION_CONFIRMATION_DELAY_MS = 60 * 1000;
const MAX_DIRECT_NOTIFICATIONS_PER_RUN = 50;
const MAX_SUBMISSION_CONFIRMATIONS_PER_RUN = 20;
const MAX_DUE_REMINDERS_PER_STAGE = 25;
const MAX_OPEN_SESSION_POLLS_PER_RUN = 25;

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

async function listCollectionEqual(env, token, name, field, value, limit = 50) {
  const response = await fetch(`${firestoreRoot(env)}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: name }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: encodeValue(value) } },
        limit: Math.max(1, Math.min(100, Number(limit) || 50)),
      },
    }),
  });
  if (!response.ok) throw new Error(`${name} (${field}=${value}): ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows.flatMap((row) => row.document ? [decodeDocument(row.document)] : []);
}

async function listCollectionDue(env, token, name, field, now, limit = MAX_DUE_REMINDERS_PER_STAGE) {
  const response = await fetch(`${firestoreRoot(env)}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: name }],
        where: {
          fieldFilter: {
            field: { fieldPath: field },
            op: "LESS_THAN_OR_EQUAL",
            value: encodeValue(now),
          },
        },
        orderBy: [{ field: { fieldPath: field }, direction: "DESCENDING" }],
        limit: Math.max(1, Math.min(100, Number(limit) || MAX_DUE_REMINDERS_PER_STAGE)),
      },
    }),
  });
  if (!response.ok) throw new Error(`${name} (${field}<=${now}): ${response.status} ${await response.text()}`);
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

async function getDocument(env, token, collectionName, id) {
  const response = await fetch(
    `${firestoreRoot(env)}/${collectionName}/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`${collectionName}/${id}: ${response.status} ${await response.text()}`);
  return decodeDocument(await response.json());
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value || "")),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function discord(env, path, init = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const multipart = typeof FormData !== "undefined" && init.body instanceof FormData;
    const response = await fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        ...(multipart ? {} : { "content-type": "application/json" }),
        ...(init.headers || {}),
      },
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

async function discordApplication(env) {
  return discord(env, "/applications/@me");
}

async function handleDiscordInteraction(request, env) {
  const rawBody = await request.text();
  let publicKey = String(env.DISCORD_PUBLIC_KEY || "").trim();
  if (!publicKey) publicKey = String((await discordApplication(env)).verify_key || "");
  const verified = await verifyDiscordInteraction(
    rawBody,
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    publicKey,
  );
  if (!verified) return json({ ok: false, error: "Invalid request signature" }, 401);

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "Invalid interaction payload" }, 400);
  }
  if (interaction.type === 1) return json({ type: 1 });
  if (interaction.type !== 2 || !["r", "personalizar"].includes(interaction.data?.name))
    return json(diceInteractionError(new Error("Este comando ainda não pertence ao grimório do Stasis.")));

  try {
    const discordUserId = String(interaction.member?.user?.id || interaction.user?.id || "");
    if (interaction.data.name === "personalizar") {
      const selected = normalizeDiceStyle(
        interaction.data?.options?.find((item) => item.name === "estilo")?.value,
      );
      if (!discordUserId || !env.DICE_PREFERENCES)
        throw new Error("O Oráculo não conseguiu guardar essa escolha agora.");
      if (selected === "cosmic") await env.DICE_PREFERENCES.delete(`style:${discordUserId}`);
      else await env.DICE_PREFERENCES.put(`style:${discordUserId}`, selected);
      const data = await personalizeDiceInteractionPayload(
        interaction,
        new URL(request.url).origin,
        env.DICE_IMAGE_SECRET,
      );
      return json({ type: 4, data });
    }
    const style = discordUserId && env.DICE_PREFERENCES
      ? normalizeDiceStyle(await env.DICE_PREFERENCES.get(`style:${discordUserId}`))
      : "cosmic";
    const data = await diceInteractionPayload(
      interaction,
      new URL(request.url).origin,
      env.DICE_IMAGE_SECRET,
      undefined,
      style,
    );
    return json({ type: 4, data });
  } catch (error) {
    return json(diceInteractionError(error));
  }
}

async function setupDiscordDice(request, env) {
  if (!env.DICE_SETUP_SECRET || request.headers.get("authorization") !== `Bearer ${env.DICE_SETUP_SECRET}`)
    return json({ ok: false, error: "Unauthorized" }, 401);
  const application = await discordApplication(env);
  const guildId = String(env.DISCORD_GUILD_ID || DEFAULT_GUILD_ID);
  const origin = new URL(request.url).origin;
  const endpointUrl = `${origin}/discord/interactions`;
  await discord(env, "/applications/@me", {
    method: "PATCH",
    body: JSON.stringify({ interactions_endpoint_url: endpointUrl }),
  });
  const commands = [];
  for (const definition of DICE_COMMAND_DEFINITIONS) {
    commands.push(await discord(env, `/applications/${application.id}/guilds/${guildId}/commands`, {
      method: "POST",
      body: JSON.stringify(definition),
    }));
  }
  const previewImageUrl = `${origin}${await createDiceImagePath([
    { die: "d4", face: 4 },
    { die: "d6", face: 6 },
    { die: "d8", face: 8 },
    { die: "d10", face: 10 },
    { die: "d12", face: 12 },
    { die: "d20", face: 20 },
  ], env.DICE_IMAGE_SECRET, "cosmic")}`;
  const previewD8ImageUrl = `${origin}${await createDiceImagePath([
    { die: "d8", face: 8 },
  ], env.DICE_IMAGE_SECRET, "blue")}`;
  return json({
    ok: true,
    applicationId: application.id,
    applicationName: application.name,
    publicKey: application.verify_key,
    guildId,
    endpointUrl,
    previewImageUrl,
    previewD8ImageUrl,
    commands: commands.map((command) => ({
      id: command.id,
      name: command.name,
      description: command.description,
    })),
  });
}

export async function cosmicDicePreview(request, env) {
  const imagePath = await createDiceImagePath([
    { die: "d8", face: 8 },
    { die: "d10", face: 6 },
    { die: "d6", face: 6 },
  ], env.DICE_IMAGE_SECRET, "cosmic");
  const response = await renderDiceImage(new Request(new URL(imagePath, request.url)), env);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

function publicJson(request, body, status = 200) {
  const origin = request.headers.get("origin") || "";
  const allowedOrigins = new Set([
    "https://stasisrpg.web.app",
    "https://stasisrpg.firebaseapp.com",
  ]);
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": allowedOrigins.has(origin)
        ? origin
        : "https://stasisrpg.web.app",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "vary": "Origin",
    },
  });
}

export function appendCombatDiceHistory(history, roll, limit = 20) {
  const previous = Array.isArray(history) ? history : [];
  return [roll, ...previous]
    .filter((item) =>
      item && Number.isInteger(Number(item.result)) &&
      Number(item.result) >= 1 && Number(item.result) <= 20 &&
      typeof item.createdAt === "string",
    )
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 20)));
}

async function rollPublicCombatD20(request, env) {
  try {
    const body = await request.json();
    const roomId = String(body?.combatId || "").trim();
    if (!/^[A-Za-z0-9_-]{10,120}$/.test(roomId))
      return publicJson(request, { ok: false, error: "Esta mesa não foi reconhecida." }, 400);
    const firebaseToken = await firebaseAccessToken(env);
    const room = await getDocument(env, firebaseToken, "publicCombatRooms", roomId);
    if (!room || room.status !== "active")
      return publicJson(request, { ok: false, error: "Esta mesa não está mais ativa." }, 404);
    const result = rollDice({ quantity: 1, sides: 20, modifier: 0, title: "" }).rolls[0];
    const now = new Date().toISOString();
    const history = await getDocument(env, firebaseToken, "combatDiceHistories", roomId);
    const roll = { id: crypto.randomUUID(), result, createdAt: now };
    await patchDocument(env, firebaseToken, "combatDiceHistories", roomId, {
      roomId,
      rolls: appendCombatDiceHistory(history?.rolls, roll),
      updatedAt: now,
    }, history?._updateTime || "");
    const origin = new URL(request.url).origin;
    return publicJson(request, {
      ok: true,
      roll,
      imageUrl: `${origin}/dice/source/cosmic/d20/d20s${result}.png`,
    });
  } catch (error) {
    console.error("public-combat-d20", error);
    return publicJson(request, {
      ok: false,
      error: "As energias do dado se dispersaram. Tente novamente em instantes.",
    }, 500);
  }
}

export async function sendDiscordAttachment(env, channelId, payload, filename, contents) {
  return sendDiscordFiles(env, channelId, payload, [{
    filename,
    contents,
    contentType: "text/plain;charset=utf-8",
    description: "Ficha completa enviada ao Stasis RPG",
  }]);
}

export async function sendDiscordFiles(env, channelId, payload, files) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    ...payload,
    attachments: files.map((file, index) => ({
      id: index,
      filename: file.filename,
      description: file.description || "Arquivo enviado pelo Stasis RPG",
    })),
  }));
  files.forEach((file, index) => {
    const blob = file.contents instanceof Blob
      ? file.contents
      : new Blob([file.contents], { type: file.contentType || "application/octet-stream" });
    form.append(`files[${index}]`, blob, file.filename);
  });
  return discord(env, `/channels/${channelId}/messages`, { method: "POST", body: form });
}

function base64Bytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decryptSubmissionConfirmation(env, confirmation) {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(env.SUBMISSION_CONFIRMATION_PRIVATE_KEY),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const rawAesKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    base64Bytes(confirmation.wrappedKey),
  );
  const aesKey = await crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64Bytes(confirmation.iv) },
    aesKey,
    base64Bytes(confirmation.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
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

export function resolveSessionPollResult(poll, votes) {
  const options = Array.isArray(poll?.options) ? poll.options : [];
  const validOptionIds = new Set(options.map((option) => String(option?.id || "")));
  const tally = new Map(options.map((option) => [String(option.id), 0]));
  for (const vote of Array.isArray(votes) ? votes : []) {
    const uniqueSelections = new Set(Array.isArray(vote?.optionIds) ? vote.optionIds : []);
    for (const optionId of uniqueSelections) {
      if (validOptionIds.has(String(optionId)))
        tally.set(String(optionId), (tally.get(String(optionId)) || 0) + 1);
    }
  }
  const voteCount = Array.isArray(votes) ? votes.length : 0;
  const highestVotes = Math.max(0, ...tally.values());
  const winningOptions = highestVotes > 0
    ? options.filter((option) => tally.get(String(option.id)) === highestVotes)
    : [];
  const targetVotes = Math.max(1, Number(poll?.targetVotes) || 1);
  const targetMet = voteCount >= targetVotes;
  const expiresAt = new Date(poll?.expiresAt || 0).getTime();
  const expired = Number.isFinite(expiresAt) && Date.now() >= expiresAt;
  return {
    tally: Object.fromEntries(tally),
    voteCount,
    highestVotes,
    winningOptions,
    winnerOptionIds: winningOptions.map((option) => String(option.id)),
    targetVotes,
    targetMet,
    expired,
    shouldClose: targetMet || expired,
    kind: winningOptions.length > 1 ? "tie" : winningOptions.length === 1 ? "winner" : "empty",
  };
}

export function sessionPollResultPayload(poll, result, env, calendarUrl = "") {
  const complete = result.targetMet;
  const tie = result.kind === "tie";
  const outcome = result.winningOptions.map((option) =>
    `${tie ? "⚖️" : "🏆"} **${safe(option.label || "Data sugerida", 180)}**\n${safe(sessionLabel(option.startsAt, env.TIME_ZONE), 300)}`,
  ).join("\n\n");
  const description = result.kind === "empty"
    ? "A consulta foi encerrada sem respostas registradas."
    : tie
      ? `A votação terminou **empatada**, e todas as escolhas vencedoras seguem abaixo.\n\n${outcome}`
      : `${complete ? "Todos responderam e a data escolhida foi:" : "O prazo terminou e a opção mais votada foi:"}\n\n${outcome}`;
  return {
    content: "||@here||",
    allowed_mentions: { parse: ["everyone"] },
    embeds: [{
      color: tie ? 0x9d6aba : result.kind === "empty" ? 0x6f7680 : 0xd3a64a,
      title: `${DRAGON_EMOJI} ${safe(poll.title || "Resultado da votação", 220)}`,
      description,
      fields: [
        { name: "Trama", value: safe(poll.tramaTitle || "Stasis RPG", 256), inline: true },
        { name: "Participação", value: `${result.voteCount} de ${result.targetVotes} resposta${result.targetVotes === 1 ? "" : "s"}`, inline: true },
        ...(tie ? [{ name: "Votos por opção empatada", value: String(result.highestVotes), inline: true }] : []),
      ],
      ...(/^https?:\/\//i.test(String(poll.image || "")) ? { image: { url: poll.image } } : {}),
      footer: { text: tie ? "Stasis RPG · Empate na agenda" : "Stasis RPG · Resultado da agenda" },
      timestamp: new Date().toISOString(),
    }],
    ...(calendarUrl && complete && result.kind === "winner" ? {
      components: [{ type: 1, components: [{
        type: 2,
        style: 5,
        label: "Adicionar ao Google Agenda",
        url: calendarUrl,
        emoji: { id: "1124393908441464873", name: "dragao" },
      }] }],
    } : {}),
    nonce: `${String(poll.id || "agenda").replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}vote`,
    enforce_nonce: true,
  };
}

export async function runSessionPolls(env, token = null) {
  const startedAt = new Date().toISOString();
  const firebaseToken = token || await firebaseAccessToken(env);
  const polls = await listCollectionEqual(env, firebaseToken, "sessionPolls", "status", "open", MAX_OPEN_SESSION_POLLS_PER_RUN);
  let closed = 0;
  let sent = 0;
  const errors = [];
  for (const poll of polls) {
    const claimedAtMs = new Date(poll.resultClaimedAt || 0).getTime();
    if (Number.isFinite(claimedAtMs) && Date.now() - claimedAtMs < CLAIM_TTL_MS) continue;
    let claimed;
    try {
      const votes = await listCollectionEqual(
        env,
        firebaseToken,
        "sessionPollVotes",
        "pollId",
        poll.id,
        Math.max(1, Math.min(100, Number(poll.targetVotes) || 1)),
      );
      const result = resolveSessionPollResult(poll, votes);
      if (!result.shouldClose) continue;
      const claimTime = new Date().toISOString();
      claimed = await patchDocument(env, firebaseToken, "sessionPolls", poll.id, {
        resultClaimedAt: claimTime,
        resultWorkerLastRunAt: claimTime,
        resultWorkerLastError: "",
      }, poll._updateTime);

      const uniqueWinner = result.targetMet && result.kind === "winner" ? result.winningOptions[0] : null;
      let calendarUrl = "";
      if (uniqueWinner && poll.bookId) {
        const book = await getDocument(env, firebaseToken, "masterBooks", poll.bookId);
        if (book) {
          const winnerTime = new Date(uniqueWinner.startsAt).getTime();
          const updatedAt = new Date().toISOString();
          const bookPatch = {
            nextSessionAt: uniqueWinner.startsAt,
            nextSessionTitle: poll.title || `Sessão de ${poll.tramaTitle || "Stasis RPG"}`,
            nextSessionDiscordChannelId: poll.discordChannelId || "",
            nextSessionImage: poll.image || "",
            nextSessionPollId: poll.id,
            sessionReminder18At: new Date(winnerTime - 18 * 60 * 60 * 1000).toISOString(),
            sessionReminder18SentAt: "",
            sessionReminder18MessageId: "",
            sessionReminder5At: new Date(winnerTime - 5 * 60 * 60 * 1000).toISOString(),
            sessionReminder5SentAt: "",
            sessionReminder5MessageId: "",
            updatedAt,
          };
          await patchDocument(env, firebaseToken, "masterBooks", book.id, bookPatch, book._updateTime);
          calendarUrl = googleCalendarUrl({ ...book, ...bookPatch }, env);
        }
      }

      let message = null;
      if (poll.discordChannelId) {
        message = await sendDiscord(env, poll.discordChannelId, sessionPollResultPayload(poll, result, env, calendarUrl));
        sent += 1;
      }
      const closedAt = new Date().toISOString();
      await patchDocument(env, firebaseToken, "sessionPolls", poll.id, {
        status: "closed",
        voteCount: result.voteCount,
        winnerOptionIds: result.winnerOptionIds,
        winnerStartsAt: uniqueWinner?.startsAt || "",
        winnerLabel: uniqueWinner?.label || (result.kind === "tie" ? `Empate entre ${result.winningOptions.length} opções` : ""),
        resultKind: result.kind,
        resultTargetMet: result.targetMet,
        resultMessageId: message?.id || "",
        resultSentAt: message ? closedAt : "",
        resultClaimedAt: "",
        resultWorkerLastRunAt: closedAt,
        resultWorkerLastSuccessAt: closedAt,
        closedAt,
      }, claimed._updateTime);
      closed += 1;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 900);
      errors.push({ pollId: poll.id, error: message });
      await patchDocument(env, firebaseToken, "sessionPolls", poll.id, {
        resultClaimedAt: "",
        resultWorkerLastRunAt: new Date().toISOString(),
        resultWorkerLastError: message,
      }).catch(() => {});
    }
  }
  return { ok: errors.length === 0, startedAt, finishedAt: new Date().toISOString(), inspected: polls.length, closed, sent, errors };
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
  const dueGroups = await Promise.all(
    REMINDER_DEFINITIONS.map((definition) =>
      listCollectionDue(
        env,
        firebaseToken,
        "masterBooks",
        definition.atField,
        startedAt,
      ),
    ),
  );
  const books = [...new Map(dueGroups.flat().map((book) => [book.id, book])).values()];
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
  let artwork = DIRECT_MESSAGE_ARTWORK;
  try {
    const parsed = new URL(String(notification.decorationUrl || "").trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") artwork = parsed.toString().slice(0, 512);
  } catch { /* Campo vazio ou inválido conserva a decoração padrão. */ }
  const isGeneralAlert = notification.sourceKind === "general_alert";
  return {
    content: isGeneralAlert
      ? `${PARCHMENT_EMOJI} **Stasis RPG - Alerta Importante**`
      : `${PARCHMENT_EMOJI} **Stasis RPG - Mensagem**`,
    embeds: [{
      color: isGeneralAlert ? 0xd3a64a : 0x9d6aba,
      title: `${isGeneralAlert ? "⚠️" : DRAGON_EMOJI} ${safe(notification.reason, 180)}`,
      description: safe(notification.details, 1800),
      fields: [{ name: "Referência", value: safe(notification.subject, 160), inline: false }],
      image: { url: artwork },
      footer: {
        text: isGeneralAlert
          ? "Stasis RPG · Notícia importante para a comunidade"
          : "Stasis RPG · Comunicação oficial",
      },
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

function traitSummary(items) {
  if (!Array.isArray(items) || !items.length) return "Não informado";
  return items.map((item) => {
    const points = Number(item?.points || 0);
    return `${points > 0 ? "+" : ""}${points} ${String(item?.name || "Escolha sem nome").trim()}`;
  }).join(" · ");
}

function submissionConfirmationFilename(characterName) {
  const slug = String(characterName || "personagem")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "personagem";
  return `ficha-${slug}.txt`;
}

export function submissionConfirmationPortraitFile(confirmation) {
  const dataUrl = String(confirmation.portrait?.dataUrl || "");
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const contentType = match[1].toLocaleLowerCase("en-US").replace("image/jpg", "image/jpeg");
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
  const filename = submissionConfirmationFilename(confirmation.characterName)
    .replace(/^ficha-/, "retrato-")
    .replace(/\.txt$/, `.${extension}`);
  return {
    filename,
    contents: new Blob([base64Bytes(match[2].replace(/\s/g, ""))], { type: contentType }),
    contentType,
    description: `Retrato de ${safe(confirmation.characterName, 160)}`,
  };
}

export function submissionConfirmationPayload(confirmation, portraitFilename = "") {
  const advantages = traitSummary(confirmation.advantages);
  const weaknesses = traitSummary(confirmation.weaknesses);
  const availability = Array.isArray(confirmation.availability) && confirmation.availability.length
    ? confirmation.availability.join(", ")
    : "Não informada";
  return {
    content: `${PARCHMENT_EMOJI} **Stasis RPG - Ficha recebida**`,
    embeds: [{
      color: 0x9d6aba,
      title: `${DRAGON_EMOJI} Confirmação de recebimento`,
      description: "Olá, aventureiro(a)! Sua ficha foi recebida com sucesso em nosso sistema. Obrigado pela participação. Fique atento ao seu Discord: assim que ela for lida, enviaremos um novo pergaminho!",
      fields: [
        { name: "Personagem", value: safe(confirmation.characterName, 256), inline: true },
        { name: "Trama", value: safe(confirmation.trama?.title || "Stasis RPG", 256), inline: true },
        { name: "Raça", value: safe(confirmation.race, 256), inline: true },
        { name: "Classe", value: safe(confirmation.className, 256), inline: true },
        { name: "Idade", value: safe(confirmation.characterAge, 256), inline: true },
        { name: "Disponibilidade", value: safe(availability, 256), inline: true },
        { name: "Vantagens", value: safe(advantages, 1024), inline: false },
        { name: "Fraquezas", value: safe(weaknesses, 1024), inline: false },
        { name: "História e tribo", value: "A ficha completa será enviada no arquivo de texto logo abaixo deste pergaminho.", inline: false },
      ],
      ...(portraitFilename ? { thumbnail: { url: `attachment://${portraitFilename}` } } : {}),
      image: { url: SUBMISSION_CONFIRMATION_ARTWORK },
      footer: { text: "Stasis RPG · Ficha registrada com sucesso" },
      timestamp: confirmation.submittedAt || new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

export function submissionConfirmationAttachment(confirmation, confirmationId = "") {
  const line = "=".repeat(72);
  return [
    "STASIS RPG — CÓPIA DA FICHA RECEBIDA",
    line,
    confirmationId ? `Protocolo: ${confirmationId}` : "",
    `Enviada em: ${confirmation.submittedAt || "Não informado"}`,
    `Jogador(a): ${confirmation.playerName || "Não informado"}`,
    `Personagem: ${confirmation.characterName || "Não informado"}`,
    `Trama: ${confirmation.trama?.title || "Stasis RPG"}`,
    `Raça: ${confirmation.race || "Não informada"}`,
    `Classe: ${confirmation.className || "Não informada"}`,
    `Idade: ${confirmation.characterAge || "Não informada"}`,
    `Disponibilidade: ${Array.isArray(confirmation.availability) ? confirmation.availability.join(", ") : "Não informada"}`,
    "",
    "VANTAGENS",
    traitSummary(confirmation.advantages),
    "",
    "FRAQUEZAS",
    traitSummary(confirmation.weaknesses),
    "",
    "FAMÍLIA OU TRIBO",
    String(confirmation.familyTribe || "Não informado").trim(),
    "",
    "HISTÓRIA",
    String(confirmation.story || "Não informada").trim(),
    "",
    line,
    "Esta é uma cópia automática dos dados enviados. Aguarde o novo pergaminho após a leitura da equipe Stasis RPG.",
  ].filter((value, index) => value !== "" || index > 0).join("\n");
}

export async function sendSubmissionConfirmation(env, channelId, confirmation, confirmationId) {
  const portrait = submissionConfirmationPortraitFile(confirmation);
  const cardPayload = {
    ...submissionConfirmationPayload(confirmation, portrait?.filename || ""),
    nonce: `${confirmationId}-card`,
    enforce_nonce: true,
  };
  const cardMessage = portrait
    ? await sendDiscordFiles(env, channelId, cardPayload, [portrait])
    : await sendDiscord(env, channelId, cardPayload);
  const attachmentMessage = await sendDiscordAttachment(
    env,
    channelId,
    {
      content: `${PARCHMENT_EMOJI} **Cópia completa da ficha de ${safe(confirmation.characterName, 120)}**\nHistória e tribo seguem no arquivo abaixo.`,
      allowed_mentions: { parse: [] },
      nonce: `${confirmationId}-file`,
      enforce_nonce: true,
    },
    submissionConfirmationFilename(confirmation.characterName),
    submissionConfirmationAttachment(confirmation, confirmationId),
  );
  return { cardMessage, attachmentMessage };
}

async function runDirectNotifications(env, token) {
  const startedAt = new Date().toISOString();
  const groups = await Promise.all([
    listCollectionEqual(env, token, "discordDirectNotifications", "status", "pending", MAX_DIRECT_NOTIFICATIONS_PER_RUN),
    listCollectionEqual(env, token, "discordDirectNotifications", "status", "processing", MAX_DIRECT_NOTIFICATIONS_PER_RUN),
  ]);
  const retryBefore = Date.now() - CLAIM_TTL_MS;
  const eligibleNotifications = groups.flat().filter((item) => item.status === "pending" || (
    item.status === "processing" && new Date(item.claimedAt || 0).getTime() < retryBefore
  )).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const notifications = eligibleNotifications.slice(0, MAX_DIRECT_NOTIFICATIONS_PER_RUN);
  const guildId = env.DISCORD_GUILD_ID || DEFAULT_GUILD_ID;
  const guildEmojis = notifications.length ? await discord(env, `/guilds/${guildId}/emojis`) : [];
  const optOutHashes = notifications.some((item) => item.sourceKind === "general_alert")
    ? new Set((await listCollection(env, token, "discordGeneralAlertOptOuts")).map((item) => item.id))
    : new Set();
  let sent = 0;
  let failed = 0;
  let suppressed = 0;
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
      if (
        claimed.sourceKind === "general_alert" &&
        optOutHashes.has(await sha256Hex(normalizeDiscordIdentity(claimed.targetDiscord)))
      ) {
        await patchDocument(env, token, "discordDirectNotifications", notification.id, {
          status: "failed",
          processedAt: new Date().toISOString(),
          error: "Alerta geral não enviado: notícias desativadas pelo destinatário.",
        }, claimed._updateTime);
        suppressed += 1;
        continue;
      }
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
    eligible: eligibleNotifications.length,
    processedThisRun: notifications.length,
    remaining: Math.max(0, eligibleNotifications.length - notifications.length),
    sent,
    failed,
    suppressed,
    deliveryFailures,
    systemErrors,
  };
}

async function runSubmissionConfirmations(env, token) {
  const startedAt = new Date().toISOString();
  const groups = await Promise.all([
    listCollectionEqual(env, token, "discordSubmissionConfirmations", "status", "pending", MAX_SUBMISSION_CONFIRMATIONS_PER_RUN),
    listCollectionEqual(env, token, "discordSubmissionConfirmations", "status", "processing", MAX_SUBMISSION_CONFIRMATIONS_PER_RUN),
  ]);
  const now = Date.now();
  const retryBefore = now - CLAIM_TTL_MS;
  const eligibleConfirmations = groups.flat().filter((item) => (
    item.status === "pending"
      ? new Date(item.createdAt || 0).getTime() + SUBMISSION_CONFIRMATION_DELAY_MS <= now
      : item.status === "processing" && new Date(item.claimedAt || 0).getTime() < retryBefore
  )).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const confirmations = eligibleConfirmations.slice(0, MAX_SUBMISSION_CONFIRMATIONS_PER_RUN);
  let sent = 0;
  let failed = 0;
  const deliveryFailures = [];
  const systemErrors = [];

  for (const confirmation of confirmations) {
    const claimedAt = new Date().toISOString();
    let claimed;
    try {
      claimed = await patchDocument(env, token, "discordSubmissionConfirmations", confirmation.id, {
        status: "processing", claimedAt, error: "",
      }, confirmation._updateTime);
    } catch (error) {
      systemErrors.push({ confirmationId: confirmation.id, stage: "claim", error: String(error?.message || error).slice(0, 500) });
      continue;
    }
    try {
      const details = await decryptSubmissionConfirmation(env, claimed);
      const member = await findGuildMember(env, details.targetDiscord);
      const directChannel = await discord(env, "/users/@me/channels", {
        method: "POST",
        body: JSON.stringify({ recipient_id: member.user.id }),
      });
      const { cardMessage } = await sendSubmissionConfirmation(env, directChannel.id, details, confirmation.id);
      await patchDocument(env, token, "discordSubmissionConfirmations", confirmation.id, {
        status: "sent",
        processedAt: new Date().toISOString(),
        discordUserId: member.user.id,
        discordMessageId: cardMessage.id || "",
        error: "",
        ciphertext: "",
        iv: "",
        wrappedKey: "",
      }, claimed._updateTime);
      sent += 1;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      try {
        await patchDocument(env, token, "discordSubmissionConfirmations", confirmation.id, {
          status: "failed",
          processedAt: new Date().toISOString(),
          error: message,
          ciphertext: "",
          iv: "",
          wrappedKey: "",
        });
        failed += 1;
        deliveryFailures.push({ confirmationId: confirmation.id, error: message });
      } catch (patchError) {
        systemErrors.push({ confirmationId: confirmation.id, stage: "failure-persist", error: String(patchError?.message || patchError).slice(0, 500) });
      }
    }
  }
  return {
    ok: systemErrors.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    inspected: groups.flat().length,
    eligible: confirmations.length,
    remaining: Math.max(0, eligibleConfirmations.length - confirmations.length),
    sent,
    failed,
    deliveryFailures,
    systemErrors,
  };
}

async function unsubscribeFromGeneralAlerts(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return publicJson(request, { ok: false, error: "Pedido inválido." }, 400);
  }
  const tokenId = String(body?.token || "").trim();
  const discordUser = String(body?.discordUser || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(tokenId) || discordUser.length < 2 || discordUser.length > 80)
    return publicJson(request, { ok: false, error: "Confira o link e o usuário informado." }, 400);
  try {
    const firebaseToken = await firebaseAccessToken(env);
    const tokenDocument = await getDocument(
      env,
      firebaseToken,
      "discordGeneralAlertTokens",
      tokenId,
    );
    if (!tokenDocument)
      return publicJson(request, { ok: false, error: "Este link não é válido ou não está mais disponível." }, 404);
    if (new Date(tokenDocument.expiresAt || 0).getTime() < Date.now())
      return publicJson(request, { ok: false, error: "Este link expirou. Fale com a equipe Stasis RPG." }, 410);
    const targetHash = await sha256Hex(normalizeDiscordIdentity(discordUser));
    if (targetHash !== tokenDocument.targetHash)
      return publicJson(request, { ok: false, error: "O usuário informado não corresponde ao destinatário deste pergaminho." }, 403);

    const existing = await getDocument(
      env,
      firebaseToken,
      "discordGeneralAlertOptOuts",
      targetHash,
    );
    const now = new Date().toISOString();
    if (!existing)
      await patchDocument(env, firebaseToken, "discordGeneralAlertOptOuts", targetHash, {
        targetHash,
        tokenId,
        createdAt: now,
      });
    if (!tokenDocument.used)
      await patchDocument(env, firebaseToken, "discordGeneralAlertTokens", tokenId, {
        used: true,
        usedAt: now,
      }, tokenDocument._updateTime);
    return publicJson(request, { ok: true });
  } catch (error) {
    console.error("general-alert-unsubscribe", error);
    return publicJson(request, { ok: false, error: "O serviço não conseguiu concluir agora. Tente novamente em instantes." }, 500);
  }
}

export async function runAutomation(env) {
  const startedAt = new Date().toISOString();
  const token = await firebaseAccessToken(env);
  const sessionPolls = await runSessionPolls(env, token);
  const reminders = await runReminders(env, token);
  const directNotifications = await runDirectNotifications(env, token);
  const submissionConfirmations = await runSubmissionConfirmations(env, token);
  return {
    ok: sessionPolls.ok && reminders.ok && directNotifications.ok && submissionConfirmations.ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    sessionPolls,
    reminders,
    directNotifications,
    submissionConfirmations,
  };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runAutomation(env).then((result) => console.log(JSON.stringify(result))));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/dice/image/") && request.method === "GET")
      return renderDiceImage(request, env);
    if ((url.pathname === "/dice/cosmic-preview" || url.pathname === "/cosmic-preview") && request.method === "GET")
      return cosmicDicePreview(request, env);
    if (url.pathname === "/discord/interactions" && request.method === "POST")
      return handleDiscordInteraction(request, env);
    if (url.pathname === "/discord/setup-dice" && request.method === "POST")
      return setupDiscordDice(request, env);
    if (url.pathname === "/dice/combat-roll" && request.method === "OPTIONS")
      return publicJson(request, { ok: true });
    if (url.pathname === "/dice/combat-roll" && request.method === "POST")
      return rollPublicCombatD20(request, env);
    if (url.pathname === "/health")
      return json({ ok: true, service: "stasis-rpg-discord-automation", scheduler: "cloud", features: ["session-polls", "session-reminders", "direct-notifications", "submission-confirmations", "general-alerts", "visual-dice-command", "dice-personalization", "public-combat-d20", "cosmic-safe-margin-v7"] });
    if (url.pathname === "/general-alerts/unsubscribe" && request.method === "OPTIONS")
      return publicJson(request, { ok: true });
    if (url.pathname === "/general-alerts/unsubscribe" && request.method === "POST")
      return unsubscribeFromGeneralAlerts(request, env);
    if (url.pathname === "/run" && request.headers.get("authorization") === `Bearer ${env.RUN_SECRET}`)
      return json(await runAutomation(env));
    return json({ ok: false, error: "Not found" }, 404);
  },
};
