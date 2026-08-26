const SUPPORTED_DICE = new Set([4, 6, 8, 10, 12, 20, 100]);
const MAX_DICE_PER_ROLL = 4;
const DICE_EMOJI = "<:d20:1537217597077200997>";
const DEFAULT_EMBED_COLOR = 0x315bd6;
const CRITICAL_EMBED_COLOR = 0xd3a64a;
const FAILURE_EMBED_COLOR = 0x9f2f3f;
const textEncoder = new TextEncoder();

function safeText(value, max = 100) {
  return String(value || "")
    .replace(/@/g, "@\u200b")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function notationError() {
  return new Error("As runas não reconheceram essa rolagem. Use `d20`, `2d6` ou `d8+3`; acrescente um título opcional depois de `@`.");
}

export function parseDiceNotation(value) {
  const input = String(value || "").trim();
  const titleSeparator = input.indexOf("@");
  const expression = (titleSeparator >= 0 ? input.slice(0, titleSeparator) : input).trim();
  const title = safeText(titleSeparator >= 0 ? input.slice(titleSeparator + 1) : "", 80);
  const match = expression.match(/^(\d{0,2})\s*d\s*(100|20|12|10|8|6|4)\s*([+-]\s*\d{1,3})?$/i);
  if (!match) throw notationError();

  const quantity = match[1] ? Number(match[1]) : 1;
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3].replace(/\s/g, "")) : 0;
  if (!SUPPORTED_DICE.has(sides) || quantity < 1 || quantity > MAX_DICE_PER_ROLL || (sides === 100 && quantity > 2) || Math.abs(modifier) > 999)
    throw notationError();

  return { quantity, sides, modifier, title };
}

function secureDie(sides) {
  const range = 0x1_0000_0000;
  const ceiling = Math.floor(range / sides) * sides;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer); while (buffer[0] >= ceiling);
  return (buffer[0] % sides) + 1;
}

export function rollDice(parsed, die = secureDie) {
  const rolls = Array.from({ length: parsed.quantity }, () => die(parsed.sides));
  const diceTotal = rolls.reduce((sum, value) => sum + value, 0);
  return { ...parsed, rolls, diceTotal, total: diceTotal + parsed.modifier };
}

export function diceImagePieces(result) {
  return result.rolls.flatMap((value) => {
    if (result.sides !== 100) return [{ die: `d${result.sides}`, face: value }];
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

export async function createDiceImagePath(pieces, secret) {
  if (!secret) throw new Error("A chave das imagens de dados não está configurada.");
  const payload = bytesToBase64Url(textEncoder.encode(JSON.stringify({ version: 1, pieces })));
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
    if (data?.version !== 1 || !Array.isArray(data.pieces) || data.pieces.length < 1 || data.pieces.length > 16)
      return null;
    if (!data.pieces.every(validPiece)) return null;
    return data.pieces;
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

export async function composeDiceImage(pieces, loadFace) {
  const size = 100;
  const gap = 8;
  const width = (pieces.length * size) + ((pieces.length - 1) * gap);
  const rgba = new Uint8Array(width * size * 4);
  const faces = await Promise.all(pieces.map(loadFace));
  faces.forEach((face, faceIndex) => {
    if (!(face instanceof Uint8Array) || face.length !== size * size * 4)
      throw new Error("Uma face dos dados não pôde ser carregada.");
    const x = faceIndex * (size + gap);
    for (let row = 0; row < size; row += 1) {
      const sourceStart = row * size * 4;
      const targetStart = ((row * width) + x) * 4;
      rgba.set(face.subarray(sourceStart, sourceStart + (size * 4)), targetStart);
    }
  });
  return encodeRgbaPng(width, size, rgba);
}

export async function renderDiceImage(request, env) {
  const pieces = await readSignedDiceImagePath(new URL(request.url).pathname, env.DICE_IMAGE_SECRET);
  if (!pieces) return new Response("A visão desta rolagem se dissipou.", { status: 404 });
  if (!env.ASSETS?.fetch) return new Response("As faces dos dados não estão disponíveis.", { status: 503 });
  try {
    if (pieces.length === 1) {
      const piece = pieces[0];
      const assetUrl = new URL(`/dice/source/blue/${piece.die}/${piece.die}s${piece.face}.png`, request.url);
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
      const assetUrl = new URL(`/dice/raw/${piece.die}/${piece.die}s${piece.face}.rgba`, request.url);
      const response = await env.ASSETS.fetch(new Request(assetUrl));
      if (!response.ok) throw new Error(`Face ${piece.die}/${piece.face} ausente.`);
      return new Uint8Array(await response.arrayBuffer());
    });
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
  return `${result.quantity > 1 ? result.quantity : ""}D${result.sides}${modifier}`;
}

function resultFooter(result) {
  const dice = result.rolls.join(" + ");
  if (!result.modifier && result.rolls.length === 1) return `Resultado: ${result.total}`;
  const modifier = result.modifier ? ` ${result.modifier > 0 ? "+" : "−"} ${Math.abs(result.modifier)}` : "";
  return `Dados: ${dice}${modifier}  •  Total: ${result.total}`;
}

export async function diceInteractionPayload(interaction, origin, secret, die = secureDie) {
  const option = interaction?.data?.options?.find((item) => item.name === "rolagem");
  const parsed = parseDiceNotation(option?.value);
  const result = rollDice(parsed, die);
  const imagePath = await createDiceImagePath(diceImagePieces(result), secret);
  const naturalCritical = result.quantity === 1 && result.sides === 20 && result.rolls[0] === 20;
  const naturalFailure = result.quantity === 1 && result.sides === 20 && result.rolls[0] === 1;
  const label = result.title || "Rolagem de Dados";
  const title = naturalCritical
    ? `✨ Acerto crítico — ${label}`
    : naturalFailure
      ? `☠️ Falha crítica — ${label}`
      : `🎲 ${label}`;

  return {
    embeds: [{
      title,
      description: `**${canonicalNotation(result)}**`,
      color: naturalCritical ? CRITICAL_EMBED_COLOR : naturalFailure ? FAILURE_EMBED_COLOR : DEFAULT_EMBED_COLOR,
      image: { url: `${String(origin).replace(/\/$/, "")}${imagePath}` },
      footer: { text: resultFooter(result) },
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
    description: "Ex.: d20@Percepção, 2d6@Dano ou d8+3@Agilidade",
    type: 3,
    required: true,
    min_length: 2,
    max_length: 120,
  }],
};
