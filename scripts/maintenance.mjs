import { randomUUID } from "node:crypto";

const action = process.argv[process.argv.indexOf("--action") + 1] || "audit-catalogs";
const projectId = process.env.FIREBASE_PROJECT_ID || "stasisrpg";
const database = "(default)";
const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${database}/documents`;
const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${database}/documents:commit`;

for (const name of [
  "FIREBASE_API_KEY",
  "FIREBASE_SERVICE_EMAIL",
  "FIREBASE_SERVICE_PASSWORD",
]) {
  if (!process.env[name]) throw new Error(`Variável obrigatória ausente: ${name}`);
}

async function accessToken() {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(process.env.FIREBASE_API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: process.env.FIREBASE_SERVICE_EMAIL,
        password: process.env.FIREBASE_SERVICE_PASSWORD,
        returnSecureToken: true,
      }),
    },
  );
  if (!response.ok) throw new Error(`Autenticação Firebase: ${response.status}`);
  return (await response.json()).idToken;
}

const token = await accessToken();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function listCollection(name) {
  const documents = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ pageSize: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    const response = await fetch(`${root}/${name}?${query}`, { headers });
    if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
    const body = await response.json();
    documents.push(...(body.documents || []));
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return documents;
}

function field(document, name) {
  return document.fields?.[name]?.stringValue || "";
}

function normalizeIdentifier(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function matchesCatalog(profileId, profileName, item) {
  const catalogId = normalizeIdentifier(item.id);
  return Boolean(catalogId) && (
    normalizeIdentifier(profileId) === catalogId ||
    normalizeIdentifier(profileName) === catalogId
  ) || String(profileName || "").localeCompare(String(item.name || ""), "pt-BR", {
    sensitivity: "base",
  }) === 0;
}

function latestCatalog(documents) {
  const latest = new Map();
  for (const document of documents) {
    try {
      const item = JSON.parse(field(document, "payload"));
      const kind = field(document, "kind");
      if (!item?.id || !["race", "class"].includes(kind)) continue;
      const key = `${kind}:${item.id}`;
      const current = latest.get(key);
      if (!current || Number(item.version) > Number(current.version)) latest.set(key, item);
    } catch {
      // Registros inválidos não participam da reconciliação.
    }
  }
  const active = [...latest.entries()].filter(([, item]) => item.active !== false && !item.deleted);
  return {
    races: active.filter(([key]) => key.startsWith("race:")).map(([, item]) => item),
    classes: active.filter(([key]) => key.startsWith("class:")).map(([, item]) => item),
  };
}

function parseModifiers(modifiers) {
  const result = {};
  const add = (key, amount) => { result[key] = Number(result[key] || 0) + amount; };
  const aliases = [
    [/^(?:hp|pontos? de vida)$/i, "hpMax"],
    [/^(?:wakfu|wp|mana)$/i, "wakfuMax"],
    [/^inteligencia$/i, "intelligence"],
    [/^poder$/i, "power"],
    [/^forca$/i, "strength"],
    [/^agilidade$/i, "agility"],
    [/^(?:defesa|df)$/i, "defense"],
    [/^(?:movimento|pm)$/i, "movement"],
    [/^pa$/i, "actionPoints"],
  ];
  const keyFor = (label) => aliases.find(([pattern]) => pattern.test(label.trim()))?.[1];
  const labels = "pontos? de vida|inteligencia|agilidade|movimento|defesa|wakfu|mana|forca|poder|hp|wp|df|pm|pa";
  for (const source of modifiers || []) {
    const line = String(source).replace(/[\u2212\u2013\u2014]/g, "-")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const before = new RegExp(`([+-]\\s*\\d+)\\s*(?:de\\s*)?(${labels})`, "gi");
    const after = new RegExp(`(${labels})(?:\\s+(?:base|maxim[oa]|natural|inicial))?\\s*([+-]\\s*\\d+)`, "gi");
    const consumed = new Set();
    for (const match of line.matchAll(before)) {
      const key = keyFor(match[2]);
      const amount = Number(match[1].replace(/\s/g, ""));
      if (!key || !Number.isFinite(amount)) continue;
      add(key, amount);
      consumed.add(`${match.index}-${match[0]}`);
    }
    for (const match of line.matchAll(after)) {
      const key = keyFor(match[1]);
      const amount = Number(match[2].replace(/\s/g, ""));
      if (!key || !Number.isFinite(amount)) continue;
      const overlaps = [...consumed].some((entry) => Math.abs(Number(entry.split("-")[0]) - Number(match.index)) < 8);
      if (!overlaps) add(key, amount);
    }
  }
  return result;
}

const baseAttributes = {
  hpCurrent: 70, hpMax: 70, wakfuCurrent: 10, wakfuMax: 10,
  intelligence: 0, precision: 0, power: 0, strength: 0, agility: 0,
  defense: 6, movement: 4, actionPoints: 1, level: 1, experience: 0,
  physicalDamage: "1D12", weaponDamage: "0", artilleryEnabled: false,
  range: "", ammunition: "",
};

function synchronizeProfile(profile, catalogs) {
  if (profile.recordType === "npc") return { profile, reasons: [] };
  const race = catalogs.races.find((item) => matchesCatalog(profile.raceCatalogId, profile.race, item));
  const gameClass = catalogs.classes.find((item) => matchesCatalog(profile.classCatalogId, profile.className, item));
  const reasons = [];
  if (!race) reasons.push(`raça sem vínculo: ${profile.race || "vazia"}`);
  if (!gameClass) reasons.push(`classe sem vínculo: ${profile.className || "vazia"}`);
  if (!race || !gameClass) return { profile, reasons, blocked: true };

  const previousLines = [...(profile.raceModifiers || []), ...(profile.classModifiers || [])];
  const currentRace = [...(race.modifiers || [])];
  const currentClass = [...(gameClass.modifiers || [])];
  const currentLines = [...currentRace, ...currentClass];
  const previous = parseModifiers(previousLines);
  const current = parseModifiers(currentLines);
  const delta = (key) => Number(current[key] || 0) - Number(previous[key] || 0);
  let attributes = { ...baseAttributes, ...(profile.attributes || {}) };
  let resourceState = profile.resourceState ? { ...profile.resourceState } : undefined;
  let baseHpVersion = Number(profile.baseHpVersion || 0);

  if (baseHpVersion < 1) {
    const legacyEmpty = Number(profile.attributes?.hpMax || 0) === 0 && Number(profile.attributes?.wakfuMax || 0) === 0;
    const hpIncrease = legacyEmpty ? 70 - Number(attributes.hpMax || 0) : 20;
    attributes = {
      ...attributes,
      hpMax: Number(attributes.hpMax || 0) + hpIncrease,
      hpCurrent: Number(attributes.hpCurrent ?? attributes.hpMax ?? 0) + hpIncrease,
    };
    if (resourceState) resourceState.hpCurrent = Math.max(0, Number(resourceState.hpCurrent || 0) + hpIncrease);
    baseHpVersion = 1;
    reasons.push("HP base atualizado para a estrutura de 70");
  }

  const hpDelta = delta("hpMax");
  const wakfuDelta = delta("wakfuMax");
  const hpMax = Math.max(0, Number(attributes.hpMax) + hpDelta);
  const wakfuMax = Math.max(0, Number(attributes.wakfuMax) + wakfuDelta);
  attributes = {
    ...attributes,
    hpMax,
    hpCurrent: Math.max(0, Math.min(hpMax, Number(attributes.hpCurrent) + hpDelta)),
    wakfuMax,
    wakfuCurrent: Math.max(0, Math.min(wakfuMax, Number(attributes.wakfuCurrent) + wakfuDelta)),
    intelligence: Number(attributes.intelligence) + delta("intelligence"),
    power: Number(attributes.power) + delta("power"),
    strength: Number(attributes.strength) + delta("strength"),
    agility: Number(attributes.agility) + delta("agility"),
    defense: Number(attributes.defense) + delta("defense"),
    movement: Number(attributes.movement) + delta("movement"),
    actionPoints: Number(attributes.actionPoints) + delta("actionPoints"),
  };
  if (resourceState) {
    resourceState = {
      hpCurrent: Math.max(0, Math.min(hpMax, Number(resourceState.hpCurrent) + hpDelta)),
      wakfuCurrent: Math.max(0, Math.min(wakfuMax, Number(resourceState.wakfuCurrent) + wakfuDelta)),
    };
  }

  if (JSON.stringify(profile.raceModifiers || []) !== JSON.stringify(currentRace)) reasons.push("modificadores de raça antigos");
  if (JSON.stringify(profile.classModifiers || []) !== JSON.stringify(currentClass)) reasons.push("modificadores de classe antigos");
  if (profile.raceCatalogId !== race.id || profile.race !== race.name) reasons.push("vínculo/nome de raça antigo");
  if (profile.classCatalogId !== gameClass.id || profile.className !== gameClass.name) reasons.push("vínculo/nome de classe antigo");

  const changed = reasons.length > 0;
  return {
    reasons,
    profile: changed ? {
      ...profile,
      version: Number(profile.version || 0) + 1,
      baseHpVersion,
      race: race.name,
      className: gameClass.name,
      raceCatalogId: race.id,
      classCatalogId: gameClass.id,
      raceModifiers: currentRace,
      classModifiers: currentClass,
      attributes,
      ...(resourceState ? { resourceState } : {}),
      updatedAt: new Date().toISOString(),
    } : profile,
  };
}

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([name, nested]) => [name, encodeValue(nested)])) } };
}

async function auditCatalogs() {
  const [optionDocuments, profileDocuments] = await Promise.all([
    listCollection("characterOptionVersions"),
    listCollection("playerProfilesCurrent"),
  ]);
  const catalogs = latestCatalog(optionDocuments);
  const plans = [];
  for (const document of profileDocuments) {
    const payload = field(document, "payload");
    if (!payload) continue;
    const profile = JSON.parse(payload);
    const result = synchronizeProfile(profile, catalogs);
    if (result.reasons.length) plans.push({ document, before: profile, ...result });
  }
  const blocked = plans.filter((item) => item.blocked);
  const actionable = plans.filter((item) => !item.blocked);
  console.log(JSON.stringify({
    mode: "audit",
    races: catalogs.races.length,
    classes: catalogs.classes.length,
    playerProfiles: profileDocuments.length,
    synchronized: profileDocuments.length - plans.length,
    pending: actionable.length,
    blocked: blocked.length,
    details: plans.map((item) => ({ character: item.before.characterName, reasons: item.reasons })),
  }, null, 2));
  if (blocked.length) throw new Error(`Há fichas sem vínculo: ${blocked.map((item) => item.before.characterName).join(", ")}`);
  if (actionable.length) process.exitCode = 2;
}

async function publishNews() {
  if (!process.env.NEWS_PAYLOAD_BASE64) throw new Error("Payload da notícia ausente.");
  if (!process.env.NEWS_SIGNATURE_BASE64) throw new Error("Assinatura editorial ausente.");
  const payload = Buffer.from(process.env.NEWS_PAYLOAD_BASE64, "base64").toString("utf8");
  const article = JSON.parse(payload);
  if (!article?.id || !article?.title || !article?.slug || article.active !== true || article.deleted) {
    throw new Error("Payload editorial inválido.");
  }
  const existing = await listCollection("newsVersions");
  const duplicate = existing.some((document) => {
    try {
      const current = JSON.parse(field(document, "payload"));
      return current.slug === article.slug && current.active && !current.deleted && (
        current.id !== article.id || Number(current.version || 0) >= Number(article.version || 0)
      );
    } catch { return false; }
  });
  if (duplicate) {
    console.log(`Notícia já publicada: ${article.slug}`);
    return;
  }
  const record = {
    schemaVersion: 1,
    newsId: article.id,
    version: article.version,
    payload,
    signature: process.env.NEWS_SIGNATURE_BASE64,
    active: true,
    deleted: false,
    title: article.title.slice(0, 180),
    slug: article.slug.slice(0, 120),
    authorName: article.authorName.slice(0, 100),
    createdAt: article.createdAt,
  };
  const fields = Object.fromEntries(Object.entries(record).map(([name, value]) => [name, name === "createdAt" ? { timestampValue: value } : encodeValue(value)]));
  const response = await fetch(`${root}/newsVersions?documentId=${randomUUID()}`, {
    method: "POST", headers, body: JSON.stringify({ fields }),
  });
  if (!response.ok) throw new Error(`Publicação: ${response.status} ${await response.text()}`);
  console.log(JSON.stringify({ published: true, id: article.id, slug: article.slug, title: article.title }, null, 2));
}

if (action === "audit-catalogs") await auditCatalogs();
else if (action === "publish-news") await publishNews();
else throw new Error(`Ação desconhecida: ${action}`);
