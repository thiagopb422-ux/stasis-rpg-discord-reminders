const SUPPORTED_DICE = new Set([4, 6, 8, 10, 12, 20, 100]);
const MAX_DICE_PER_ROLL = 6;
const DICE_EMOJI = "<:d20:1537217597077200997>";
const DEFAULT_EMBED_COLOR = 0x315bd6;
const CRITICAL_EMBED_COLOR = 0xd3a64a;
const FAILURE_EMBED_COLOR = 0x9f2f3f;
const DICE_STYLES = new Set(["cosmic", "redpill", "eniripsa", "begins", "blue"]);
const COMPLETE_DICE_STYLES = new Set(["cosmic", "redpill", "eniripsa", "begins"]);
const CUSTOM_DICE = new Set(["d4", "d6", "d8", "d10", "d12", "d20"]);
const textEncoder = new TextEncoder();

export function normalizeDiceStyle(value) {
  return DICE_STYLES.has(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "cosmic";
}

function safeText(value, max = 100) {
  return String(value || "")
    .replace(/@/g, "@\u200b")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function notationError() {
  return new Error("As runas não reconheceram essa rolagem. Use `d20`, `6d6`, `d8+3` ou misture até seis dados como `3d20+3d8`; acrescente um título opcional depois de `@`.");
}

export function parseDiceNotation(value) {
  const input = String(value || "")
    .trim()
    .replace(/^\/r\s+/i, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
  const titleSeparator = input.indexOf("@");
  const expression = (titleSeparator >= 0 ? input.slice(0, titleSeparator) : input).trim();
  const title = safeText(titleSeparator >= 0 ? input.slice(titleSeparator + 1) : "", 80);
  const compact = expression.replace(/\s/g, "").toLowerCase();
  const tokens = compact.match(/[+-]?[^+-]+/g);
  if (!tokens || tokens.join("") !== compact || !/^\d{0,2}d/.test(tokens[0]))
    throw notationError();

  const grouped = new Map();
  let modifier = 0;
  for (const token of tokens) {
    const dice = token.match(/^\+?(\d{0,2})d(100|20|12|10|8|6|4)$/);
    if (dice) {
      const quantity = dice[1] ? Number(dice[1]) : 1;
      const sides = Number(dice[2]);
      if (!SUPPORTED_DICE.has(sides) || quantity < 1) throw notationError();
      grouped.set(sides, (grouped.get(sides) || 0) + quantity);
      continue;
    }
    if (!/^[+-]\d{1,3}$/.test(token)) throw notationError();
    modifier += Number(token);
  }
  const groups = Array.from(grouped, ([sides, quantity]) => ({ quantity, sides }));
  const quantity = groups.reduce((sum, group) => sum + group.quantity, 0);
  if (!groups.length || quantity > MAX_DICE_PER_ROLL || Math.abs(modifier) > 999)
    throw notationError();
  if (groups.length === 1)
    return { quantity: groups[0].quantity, sides: groups[0].sides, modifier, title };
  return { groups, modifier, title };
}

function secureDie(sides) {
  const range = 0x1_0000_0000;
  const ceiling = Math.floor(range / sides) * sides;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer); while (buffer[0] >= ceiling);
  return (buffer[0] % sides) + 1;
}

export function rollDice(parsed, die = secureDie) {
  const groups = parsed.groups || [{ quantity: parsed.quantity, sides: parsed.sides }];
  const diceRolls = groups.flatMap((group) =>
    Array.from({ length: group.quantity }, () => ({
      sides: group.sides,
      value: die(group.sides),
    })),
  );
  const rolls = diceRolls.map((roll) => roll.value);
  const diceTotal = rolls.reduce((sum, value) => sum + value, 0);
  return { ...parsed, groups, diceRolls, rolls, diceTotal, total: diceTotal + parsed.modifier };
}

export function diceImagePieces(result) {
  const diceRolls = result.diceRolls || result.rolls.map((value) => ({
    sides: result.sides,
    value,
  }));
  return diceRolls.flatMap(({ sides, value }) => {
    if (sides !== 100) return [{ die: `d${sides}`, face: value }];
    let tens = Math.floor(value / 10);
    let ones = value - (tens * 10);
    if (tens === 0) tens = 10;
    if (ones === 0) ones = 10;
    return [{ die: "d100", face: tens }, { die: "d10", face: ones }];
  });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hexToBytes(value) {
  const source = String(value || "").trim();
  if (!/^[a-f0-9]+$/i.test(source) || source.length % 2) return null;
  return Uint8Array.from(source.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)));
}

export async function createDiceImagePath(pieces, secret, style = "cosmic") {
  if (!secret) throw new Error("A chave das imagens de dados não está configurada.");
  const payload = bytesToBase64Url(textEncoder.encode(JSON.stringify({
    version: 9,
    style: normalizeDiceStyle(style),
    pieces,
  })));
  const signature = bytesToBase64Url(await hmac(secret, payload)).slice(0, 32);
  return `/dice/image/${payload}.${signature}.png`;
}

function constantTimeEqual(left, right) {
  const leftBytes = textEncoder.encode(String(left || ""));
  const rightBytes = textEncoder.encode(String(right || ""));
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function validPiece(piece) {
  if (!piece || typeof piece !== "object") return false;
  const sides = Number(String(piece.die || "").replace(/^d/, ""));
  const face = Number(piece.face);
  if (!SUPPORTED_DICE.has(sides) || !Number.isInteger(face)) return false;
  if (sides === 100) return face >= 1 && face <= 10;
  return face >= 1 && face <= sides;
}

export async function readSignedDiceImagePath(pathname, secret) {
  const match = String(pathname || "").match(/^\/dice\/image\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{32})\.png$/);
  if (!match || !secret) return null;
  const expected = bytesToBase64Url(await hmac(secret, match[1])).slice(0, 32);
  if (!constantTimeEqual(expected, match[2])) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(match[1])));
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(data?.version) || !Array.isArray(data.pieces) || data.pieces.length < 1 || data.pieces.length > 16)
      return null;
    if (!data.pieces.every(validPiece)) return null;
    return {
      style: data.version === 1 ? "blue" : normalizeDiceStyle(data.style),
      pieces: data.pieces,
    };
  } catch {
    return null;
  }
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = new Uint8Array()) {
  const typeBytes = textEncoder.encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  const checksumInput = new Uint8Array(typeBytes.length + data.length);
  checksumInput.set(typeBytes);
  checksumInput.set(data, typeBytes.length);
  view.setUint32(8 + data.length, crc32(checksumInput));
  return output;
}

function joinBytes(chunks) {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function encodeRgbaPng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error("A composição dos dados ficou incompleta.");
  const scanlines = new Uint8Array(height * ((width * 4) + 1));
  for (let row = 0; row < height; row += 1) {
    const target = row * ((width * 4) + 1);
    scanlines[target] = 0;
    scanlines.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), target + 1);
  }
  const compressedStream = new Blob([scanlines]).stream().pipeThrough(new CompressionStream("deflate"));
  const compressed = new Uint8Array(await new Response(compressedStream).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return joinBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND"),
  ]);
}

export async function composeDiceImage(pieces, loadFace, size = 100) {
  const gap = Math.max(8, Math.round(size * 0.08));
  const columns = pieces.length <= 4 ? pieces.length : pieces.length <= 6 ? 3 : 4;
  const rows = Math.ceil(pieces.length / columns);
  const width = (columns * size) + ((columns - 1) * gap);
  const height = (rows * size) + ((rows - 1) * gap);
  const rgba = new Uint8Array(width * height * 4);
  const faces = await Promise.all(pieces.map(loadFace));
  faces.forEach((face, faceIndex) => {
    if (!(face instanceof Uint8Array) || face.length !== size * size * 4)
      throw new Error("Uma face dos dados não pôde ser carregada.");
    const row = Math.floor(faceIndex / columns);
    const column = faceIndex % columns;
    const itemsInRow = Math.min(columns, pieces.length - (row * columns));
    const rowWidth = (itemsInRow * size) + ((itemsInRow - 1) * gap);
    const x = Math.floor((width - rowWidth) / 2) + (column * (size + gap));
    const y = row * (size + gap);
    for (let pixelRow = 0; pixelRow < size; pixelRow += 1) {
      const sourceStart = pixelRow * size * 4;
      const targetStart = ((((y + pixelRow) * width) + x) * 4);
      rgba.set(face.subarray(sourceStart, sourceStart + (size * 4)), targetStart);
    }
  });
  return encodeRgbaPng(width, height, rgba);
}

export async function renderDiceImage(request, env) {
  const signed = await readSignedDiceImagePath(new URL(request.url).pathname, env.DICE_IMAGE_SECRET);
  if (!signed) return new Response("A visão desta rolagem se dissipou.", { status: 404 });
  const { pieces, style } = signed;
  if (!env.ASSETS?.fetch) return new Response("As faces dos dados não estão disponíveis.", { status: 503 });
  const assetPiece = (piece) => COMPLETE_DICE_STYLES.has(style) && piece.die === "d100"
    ? { ...piece, die: "d10" }
    : piece;
  const assetStyle = (piece) => COMPLETE_DICE_STYLES.has(style) && CUSTOM_DICE.has(assetPiece(piece).die)
    ? style
    : "blue";
  const faceSize = style === "begins" ? 125 : 100;
  try {
    if (pieces.length === 1) {
      const piece = assetPiece(pieces[0]);
      const selectedStyle = assetStyle(piece);
      const sourceStyle = selectedStyle === "blue" ? "blue" : `${selectedStyle}-compact`;
      const assetUrl = new URL(`/dice/source/${sourceStyle}/${piece.die}/${piece.die}s${piece.face}.png`, request.url);
      const asset = await env.ASSETS.fetch(new Request(assetUrl));
      if (!asset.ok) throw new Error(`Face ${piece.die}/${piece.face} ausente.`);
      const headers = new Headers(asset.headers);
      headers.set("content-type", "image/png");
      headers.set("cache-control", "public, max-age=31536000, immutable");
      headers.set("content-disposition", "inline; filename=stasis-rpg-dado.png");
      headers.set("x-content-type-options", "nosniff");
      return new Response(asset.body, { status: asset.status, headers });
    }
    const png = await composeDiceImage(pieces, async (piece) => {
      const selectedPiece = assetPiece(piece);
      const faceStyle = assetStyle(selectedPiece);
      const assetUrl = new URL(
        faceStyle === "blue"
          ? `/dice/raw/${selectedPiece.die}/${selectedPiece.die}s${selectedPiece.face}.rgba`
          : `/dice/raw/${faceStyle}/${selectedPiece.die}/${selectedPiece.die}s${selectedPiece.face}.rgba`,
        request.url,
      );
      const response = await env.ASSETS.fetch(new Request(assetUrl));
      if (!response.ok) throw new Error(`Face ${piece.die}/${piece.face} ausente.`);
      return new Uint8Array(await response.arrayBuffer());
    }, faceSize);
    return new Response(png, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
        "content-disposition": "inline; filename=stasis-rpg-dados.png",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("dice-image", error);
    return new Response("O Oráculo não conseguiu revelar os dados.", { status: 500 });
  }
}

function canonicalNotation(result) {
  const modifier = result.modifier ? `${result.modifier > 0 ? "+" : ""}${result.modifier}` : "";
  const groups = result.groups || [{ quantity: result.quantity, sides: result.sides }];
  const dice = groups
    .map((group) => `${group.quantity > 1 ? group.quantity : ""}D${group.sides}`)
    .join("+");
  return `${dice}${modifier}`;
}

export async function diceInteractionPayload(interaction, origin, secret, die = secureDie, style = "cosmic") {
  const option = interaction?.data?.options?.find((item) => item.name === "rolagem");
  const parsed = parseDiceNotation(option?.value);
  const result = rollDice(parsed, die);
  const imagePath = await createDiceImagePath(diceImagePieces(result), secret, style);
  const naturalCritical = result.diceRolls.length === 1 && result.diceRolls[0].sides === 20 && result.rolls[0] === 20;
  const naturalFailure = result.diceRolls.length === 1 && result.diceRolls[0].sides === 20 && result.rolls[0] === 1;
  const label = result.title || "Rolagem de Dados";
  const resultLabel = result.rolls.length === 1 && !result.modifier ? "Resultado" : "Total";
  const title = naturalCritical
    ? `✨ Acerto crítico — ${label}`
    : naturalFailure
      ? `☠️ Falha crítica — ${label}`
      : `🎲 ${label}`;

  return {
    embeds: [{
      title,
      description: `**${canonicalNotation(result)}**  •  ${resultLabel}: **${result.total}**`,
      color: naturalCritical ? CRITICAL_EMBED_COLOR : naturalFailure ? FAILURE_EMBED_COLOR : DEFAULT_EMBED_COLOR,
      image: { url: `${String(origin).replace(/\/$/, "")}${imagePath}` },
    }],
    allowed_mentions: { parse: [] },
  };
}

export async function personalizeDiceInteractionPayload(interaction, origin, secret) {
  const selected = interaction?.data?.options?.find((item) => item.name === "estilo")?.value;
  const style = normalizeDiceStyle(selected);
  const imagePath = await createDiceImagePath([{ die: "d20", face: 20 }], secret, style);
  const presentation = {
    cosmic: {
      label: "Cósmico",
      description: "Este é o padrão completo do Stasis. D4, D6, D8, D10, D12, D20 e D100 usam a arte Cósmica.",
      color: 0x7b4fd5,
    },
    redpill: {
      label: "Redpill",
      description: "D4, D6, D8, D10, D12, D20 e D100 agora usam o conjunto Redpill completo.",
      color: 0xc92f2f,
    },
    eniripsa: {
      label: "Eniripsa",
      description: "D4, D6, D8, D10, D12, D20 e D100 agora usam o conjunto Eniripsa completo.",
      color: 0xd986c7,
    },
    begins: {
      label: "Begins",
      description: "D4, D6, D8, D10, D12, D20 e D100 agora usam o conjunto Begins completo.",
      color: 0x9ca9c8,
    },
    blue: {
      label: "Azul",
      description: "Todas as suas rolagens voltaram a usar o conjunto clássico azul.",
      color: DEFAULT_EMBED_COLOR,
    },
  }[style];
  return {
    flags: 64,
    embeds: [{
      title: `✨ Conjunto ${presentation.label} selecionado`,
      description: presentation.description,
      color: presentation.color,
      thumbnail: { url: `${String(origin).replace(/\/$/, "")}${imagePath}` },
      footer: { text: "A escolha fica salva para as próximas rolagens." },
    }],
    allowed_mentions: { parse: [] },
  };
}

export function diceInteractionError(error) {
  return {
    type: 4,
    data: {
      content: `${DICE_EMOJI} ${safeText(error?.message || "O Oráculo dos Dados não conseguiu interpretar o pedido.", 500)}`,
      flags: 64,
      allowed_mentions: { parse: [] },
    },
  };
}

export async function verifyDiscordInteraction(rawBody, signatureHex, timestamp, publicKeyHex) {
  const signature = hexToBytes(signatureHex);
  const publicKey = hexToBytes(publicKeyHex);
  if (!signature || !publicKey || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    const message = textEncoder.encode(`${timestamp}${rawBody}`);
    return crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  } catch {
    return false;
  }
}

export const DICE_COMMAND_DEFINITION = {
  name: "r",
  type: 1,
  description: "Role os dados do Stasis RPG",
  options: [{
    name: "rolagem",
    description: "Misture até 6 dados. Ex.: 3d20+3d8 ou d20+5@Percepção",
    type: 3,
    required: true,
    min_length: 2,
    max_length: 120,
  }],
};

export const DICE_PERSONALIZE_COMMAND_DEFINITION = {
  name: "personalizar",
  type: 1,
  description: "Escolha a aparência dos seus dados do Stasis RPG",
  options: [{
    name: "estilo",
    description: "O conjunto visual usado nas próximas rolagens",
    type: 3,
    required: true,
    choices: [
      { name: "Cósmico (padrão)", value: "cosmic" },
      { name: "Redpill", value: "redpill" },
      { name: "Eniripsa", value: "eniripsa" },
      { name: "Begins", value: "begins" },
      { name: "Azul", value: "blue" },
    ],
  }],
};

export const DICE_COMMAND_DEFINITIONS = [
  DICE_COMMAND_DEFINITION,
  DICE_PERSONALIZE_COMMAND_DEFINITION,
];
