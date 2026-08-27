import assert from 'node:assert/strict'
import {
  appendCombatDiceHistory,
  cosmicDicePreview,
  directNotificationPayload,
  resolveSessionPollResult,
  resolveButtonEmoji,
  runReminders,
  sessionPollResultPayload,
  sendSubmissionConfirmation,
  submissionConfirmationAttachment,
  submissionConfirmationPayload,
  submissionConfirmationPortraitFile,
} from './src/index.js'
import {
  composeDiceImage,
  createDiceImagePath,
  diceImagePieces,
  diceInteractionPayload,
  normalizeDiceStyle,
  parseDiceNotation,
  personalizeDiceInteractionPayload,
  readSignedDiceImagePath,
  renderDiceImage,
  rollDice,
  verifyDiscordInteraction,
} from './src/dice.js'

const parsedDice = parseDiceNotation('2d6+3@Dano da Espada')
assert.deepEqual(parsedDice, {
  quantity: 2,
  sides: 6,
  modifier: 3,
  title: 'Dano da Espada',
})
assert.deepEqual(parseDiceNotation('6d6'), {
  quantity: 6,
  sides: 6,
  modifier: 0,
  title: '',
})
assert.throws(() => parseDiceNotation('7d6@Excesso'), /runas não reconheceram/i)
assert.throws(() => parseDiceNotation('d7@Dado impossível'), /runas não reconheceram/i)
assert.equal(parseDiceNotation('d8').sides, 8)
assert.equal(parseDiceNotation('D8').sides, 8)
assert.equal(parseDiceNotation('/r d8@Agilidade').sides, 8)
assert.equal(parseDiceNotation('**d8**').sides, 8)
const mixedParsedDice = parseDiceNotation('3d20 + 1d8@Ataque combinado')
assert.deepEqual(mixedParsedDice, {
  groups: [
    { quantity: 3, sides: 20 },
    { quantity: 1, sides: 8 },
  ],
  modifier: 0,
  title: 'Ataque combinado',
})
assert.equal(parseDiceNotation('3d20+2d8').groups.reduce((sum, group) => sum + group.quantity, 0), 5)
assert.throws(() => parseDiceNotation('3d20+4d8'), /seis dados/i)
assert.throws(() => parseDiceNotation('d20-1d8'), /seis dados/i)

const deterministicRoll = rollDice(parsedDice, (() => {
  const values = [4, 6]
  return () => values.shift()
})())
assert.deepEqual(deterministicRoll.rolls, [4, 6])
assert.equal(deterministicRoll.total, 13)
const mixedRoll = rollDice(mixedParsedDice, (() => {
  const values = [11, 12, 13, 5]
  return () => values.shift()
})())
assert.deepEqual(mixedRoll.rolls, [11, 12, 13, 5])
assert.deepEqual(mixedRoll.diceRolls, [
  { sides: 20, value: 11 },
  { sides: 20, value: 12 },
  { sides: 20, value: 13 },
  { sides: 8, value: 5 },
])
assert.equal(mixedRoll.total, 41)
assert.deepEqual(diceImagePieces(mixedRoll), [
  { die: 'd20', face: 11 },
  { die: 'd20', face: 12 },
  { die: 'd20', face: 13 },
  { die: 'd8', face: 5 },
])
assert.deepEqual(diceImagePieces({ sides: 100, rolls: [37] }), [
  { die: 'd100', face: 3 },
  { die: 'd10', face: 7 },
])
assert.deepEqual(diceImagePieces({ sides: 100, rolls: [100] }), [
  { die: 'd100', face: 10 },
  { die: 'd10', face: 10 },
])

const diceImageSecret = 'segredo-local-de-imagem'
const dicePieces = [{ die: 'd20', face: 20 }, { die: 'd6', face: 4 }]
const signedDicePath = await createDiceImagePath(dicePieces, diceImageSecret)
assert.deepEqual(await readSignedDiceImagePath(signedDicePath, diceImageSecret), {
  style: 'cosmic',
  pieces: dicePieces,
})
assert.equal(await readSignedDiceImagePath(signedDicePath.replace('.png', 'x.png'), diceImageSecret), null)
assert.equal(normalizeDiceStyle('blue'), 'blue')
assert.equal(normalizeDiceStyle('qualquer-coisa'), 'cosmic')

const flatFaceSized = (size, red, green, blue) => {
  const face = new Uint8Array(size * size * 4)
  for (let index = 0; index < face.length; index += 4) face.set([red, green, blue, 255], index)
  return face
}
const flatFace = (red, green, blue) => flatFaceSized(100, red, green, blue)
const composedDice = await composeDiceImage(dicePieces, async (_piece, index) => index ? flatFace(0, 0, 255) : flatFace(255, 0, 0))
assert.deepEqual(Array.from(composedDice.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10])
assert.equal(new DataView(composedDice.buffer, composedDice.byteOffset).getUint32(16), 208)
assert.equal(new DataView(composedDice.buffer, composedDice.byteOffset).getUint32(20), 100)

const sixDice = await composeDiceImage(
  Array.from({ length: 6 }, () => ({ die: 'd6', face: 6 })),
  async () => flatFace(190, 35, 35),
)
assert.equal(new DataView(sixDice.buffer, sixDice.byteOffset).getUint32(16), 316)
assert.equal(new DataView(sixDice.buffer, sixDice.byteOffset).getUint32(20), 208)

const beginsPair = await composeDiceImage(
  [{ die: 'd6', face: 1 }, { die: 'd6', face: 2 }],
  async () => flatFaceSized(125, 42, 76, 170),
  125,
)
assert.equal(new DataView(beginsPair.buffer, beginsPair.byteOffset).getUint32(16), 260)
assert.equal(new DataView(beginsPair.buffer, beginsPair.byteOffset).getUint32(20), 125)

const diceImageRequest = new Request(`https://dice.stasis.test${signedDicePath}`)
const renderedDiceResponse = await renderDiceImage(diceImageRequest, {
  DICE_IMAGE_SECRET: diceImageSecret,
  ASSETS: { fetch: async () => new Response(flatFace(35, 73, 214)) },
})
assert.equal(renderedDiceResponse.status, 200)
assert.equal(renderedDiceResponse.headers.get('content-type'), 'image/png')
assert.equal((await renderedDiceResponse.arrayBuffer()).byteLength > 100, true)

const safeMarginPreview = await cosmicDicePreview(
  new Request('https://dice.stasis.test/dice/cosmic-preview'),
  {
    DICE_IMAGE_SECRET: diceImageSecret,
    ASSETS: { fetch: async () => new Response(flatFace(35, 73, 214)) },
  },
)
assert.equal(safeMarginPreview.status, 200)
assert.equal(safeMarginPreview.headers.get('content-type'), 'image/png')
assert.equal(safeMarginPreview.headers.get('cache-control'), 'no-store')

const compactCosmicPath = await createDiceImagePath(
  [{ die: 'd20', face: 20 }],
  diceImageSecret,
  'cosmic',
)
let requestedCosmicAsset = ''
const compactCosmicResponse = await renderDiceImage(
  new Request(`https://dice.stasis.test${compactCosmicPath}`),
  {
    DICE_IMAGE_SECRET: diceImageSecret,
    ASSETS: {
      fetch: async (request) => {
        requestedCosmicAsset = new URL(request.url).pathname
        return new Response(new Uint8Array([137, 80, 78, 71]))
      },
    },
  },
)
assert.equal(compactCosmicResponse.status, 200)
assert.equal(requestedCosmicAsset, '/dice/source/cosmic-compact/d20/d20s20.png')

for (const [die, face] of [['d4', 4], ['d6', 6], ['d8', 8], ['d10', 10], ['d12', 12]]) {
  const path = await createDiceImagePath([{ die, face }], diceImageSecret, 'cosmic')
  let requestedAsset = ''
  const response = await renderDiceImage(new Request(`https://dice.stasis.test${path}`), {
    DICE_IMAGE_SECRET: diceImageSecret,
    ASSETS: {
      fetch: async (request) => {
        requestedAsset = new URL(request.url).pathname
        return new Response(new Uint8Array([137, 80, 78, 71]))
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(requestedAsset, `/dice/source/cosmic-compact/${die}/${die}s${face}.png`)
}

const mixedCosmicPath = await createDiceImagePath(
  [{ die: 'd10', face: 7 }, { die: 'd12', face: 11 }, { die: 'd8', face: 4 }],
  diceImageSecret,
  'cosmic',
)
const requestedMixedAssets = []
const mixedCosmicResponse = await renderDiceImage(
  new Request(`https://dice.stasis.test${mixedCosmicPath}`),
  {
    DICE_IMAGE_SECRET: diceImageSecret,
    ASSETS: {
      fetch: async (request) => {
        requestedMixedAssets.push(new URL(request.url).pathname)
        return new Response(flatFace(35, 73, 214))
      },
    },
  },
)
assert.equal(mixedCosmicResponse.status, 200)
assert.deepEqual(requestedMixedAssets, [
  '/dice/raw/cosmic/d10/d10s7.rgba',
  '/dice/raw/cosmic/d12/d12s11.rgba',
  '/dice/raw/cosmic/d8/d8s4.rgba',
])

const cosmicD100Path = await createDiceImagePath(
  [{ die: 'd100', face: 3 }, { die: 'd10', face: 7 }],
  diceImageSecret,
  'cosmic',
)
const requestedD100Assets = []
const cosmicD100Response = await renderDiceImage(
  new Request(`https://dice.stasis.test${cosmicD100Path}`),
  {
    DICE_IMAGE_SECRET: diceImageSecret,
    ASSETS: {
      fetch: async (request) => {
        requestedD100Assets.push(new URL(request.url).pathname)
        return new Response(flatFace(35, 73, 214))
      },
    },
  },
)
assert.equal(cosmicD100Response.status, 200)
assert.deepEqual(requestedD100Assets, [
  '/dice/raw/cosmic/d10/d10s3.rgba',
  '/dice/raw/cosmic/d10/d10s7.rgba',
])

const redpillPath = await createDiceImagePath(
  [{ die: 'd100', face: 3 }, { die: 'd10', face: 7 }, { die: 'd6', face: 6 }],
  diceImageSecret,
  'redpill',
)
const requestedRedpillAssets = []
const redpillResponse = await renderDiceImage(
  new Request(`https://dice.stasis.test${redpillPath}`),
  {
    DICE_IMAGE_SECRET: diceImageSecret,
    ASSETS: {
      fetch: async (request) => {
        requestedRedpillAssets.push(new URL(request.url).pathname)
        return new Response(flatFace(180, 35, 35))
      },
    },
  },
)
assert.equal(redpillResponse.status, 200)
assert.deepEqual(requestedRedpillAssets, [
  '/dice/raw/redpill/d10/d10s3.rgba',
  '/dice/raw/redpill/d10/d10s7.rgba',
  '/dice/raw/redpill/d6/d6s6.rgba',
])

for (const style of ['eniripsa', 'begins']) {
  const path = await createDiceImagePath([{ die: 'd20', face: 20 }], diceImageSecret, style)
  let requestedAsset = ''
  const response = await renderDiceImage(new Request(`https://dice.stasis.test${path}`), {
    DICE_IMAGE_SECRET: diceImageSecret,
    ASSETS: {
      fetch: async (request) => {
        requestedAsset = new URL(request.url).pathname
        return new Response(new Uint8Array([137, 80, 78, 71]))
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(requestedAsset, `/dice/source/${style}-compact/d20/d20s20.png`)
}

const beginsPairPath = await createDiceImagePath(
  [{ die: 'd6', face: 1 }, { die: 'd6', face: 2 }],
  diceImageSecret,
  'begins',
)
const requestedBeginsPairAssets = []
const beginsPairResponse = await renderDiceImage(
  new Request(`https://dice.stasis.test${beginsPairPath}`),
  {
    DICE_IMAGE_SECRET: diceImageSecret,
    ASSETS: {
      fetch: async (request) => {
        requestedBeginsPairAssets.push(new URL(request.url).pathname)
        return new Response(flatFaceSized(125, 42, 76, 170))
      },
    },
  },
)
assert.equal(beginsPairResponse.status, 200)
assert.deepEqual(requestedBeginsPairAssets, [
  '/dice/raw/begins/d6/d6s1.rgba',
  '/dice/raw/begins/d6/d6s2.rgba',
])
const beginsPairPng = new Uint8Array(await beginsPairResponse.arrayBuffer())
assert.equal(new DataView(beginsPairPng.buffer, beginsPairPng.byteOffset).getUint32(16), 260)
assert.equal(new DataView(beginsPairPng.buffer, beginsPairPng.byteOffset).getUint32(20), 125)

const criticalInteraction = await diceInteractionPayload({
  data: { options: [{ name: 'rolagem', value: 'd20@Lance de Percepção' }] },
  member: { nick: 'Aventureiro', user: { username: 'jogador' } },
}, 'https://dice.stasis.test', diceImageSecret, () => 20)
assert.equal(criticalInteraction.content, undefined)
assert.equal(criticalInteraction.embeds[0].description, '**D20**  •  Resultado: **20**')
assert.equal(JSON.stringify(criticalInteraction).includes('Aventureiro'), false)
assert.equal(criticalInteraction.embeds[0].title.includes('Acerto crítico'), true)
assert.equal(criticalInteraction.embeds[0].image.url.startsWith('https://dice.stasis.test/dice/image/'), true)
assert.equal(criticalInteraction.embeds[0].footer, undefined)

const modifiedInteraction = await diceInteractionPayload({
  data: { options: [{ name: 'rolagem', value: 'd20+5@Percepção' }] },
}, 'https://dice.stasis.test', diceImageSecret, () => 11)
assert.equal(modifiedInteraction.embeds[0].description, '**D20+5**  •  Total: **16**')
assert.equal(modifiedInteraction.embeds[0].footer, undefined)
assert.equal(modifiedInteraction.embeds[0].fields, undefined)

const mixedInteraction = await diceInteractionPayload({
  data: { options: [{ name: 'rolagem', value: '3d20 + 1d8' }] },
}, 'https://dice.stasis.test', diceImageSecret, (() => {
  const values = [11, 12, 13, 5]
  return () => values.shift()
})())
assert.equal(mixedInteraction.embeds[0].description, '**3D20+D8**  •  Total: **41**')
assert.equal(mixedInteraction.embeds[0].footer, undefined)
assert.equal(mixedInteraction.embeds[0].fields, undefined)

const blueInteraction = await diceInteractionPayload({
  data: { options: [{ name: 'rolagem', value: 'd20' }] },
}, 'https://dice.stasis.test', diceImageSecret, () => 8, 'blue')
const blueSignedUrl = new URL(blueInteraction.embeds[0].image.url)
assert.equal((await readSignedDiceImagePath(blueSignedUrl.pathname, diceImageSecret)).style, 'blue')
assert.equal(normalizeDiceStyle('redpill'), 'redpill')
assert.equal(normalizeDiceStyle('eniripsa'), 'eniripsa')
assert.equal(normalizeDiceStyle('begins'), 'begins')

const personalizeInteraction = await personalizeDiceInteractionPayload({
  data: { options: [{ name: 'estilo', value: 'cosmic' }] },
}, 'https://dice.stasis.test', diceImageSecret)
assert.equal(personalizeInteraction.flags, 64)
assert.equal(personalizeInteraction.embeds[0].title.includes('Cósmico'), true)
const redpillPersonalizeInteraction = await personalizeDiceInteractionPayload({
  data: { options: [{ name: 'estilo', value: 'redpill' }] },
}, 'https://dice.stasis.test', diceImageSecret)
assert.equal(redpillPersonalizeInteraction.embeds[0].title.includes('Redpill'), true)
for (const [style, label] of [['eniripsa', 'Eniripsa'], ['begins', 'Begins']]) {
  const personalized = await personalizeDiceInteractionPayload({
    data: { options: [{ name: 'estilo', value: style }] },
  }, 'https://dice.stasis.test', diceImageSecret)
  assert.equal(personalized.embeds[0].title.includes(label), true)
}

const combatHistory = appendCombatDiceHistory([
  { id: 'anterior', result: 7, createdAt: '2026-08-26T12:00:00.000Z' },
], { id: 'novo', result: 20, createdAt: '2026-08-26T12:01:00.000Z' }, 2)
assert.deepEqual(combatHistory.map((item) => item.result), [20, 7])
assert.equal(appendCombatDiceHistory(combatHistory, {
  id: 'invalido', result: 21, createdAt: '2026-08-26T12:02:00.000Z',
}).some((item) => item.result === 21), false)

const interactionKeys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const rawInteraction = JSON.stringify({ type: 1 })
const interactionTimestamp = '1787673600'
const interactionSignature = new Uint8Array(await crypto.subtle.sign(
  { name: 'Ed25519' },
  interactionKeys.privateKey,
  new TextEncoder().encode(`${interactionTimestamp}${rawInteraction}`),
))
const interactionPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', interactionKeys.publicKey))
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
assert.equal(await verifyDiscordInteraction(rawInteraction, toHex(interactionSignature), interactionTimestamp, toHex(interactionPublicKey)), true)
assert.equal(await verifyDiscordInteraction(`${rawInteraction} `, toHex(interactionSignature), interactionTimestamp, toHex(interactionPublicKey)), false)

const poll = {
  id: 'poll-agenda-teste',
  title: 'Próxima jornada',
  tramaTitle: 'Begins',
  targetVotes: 4,
  expiresAt: '2099-08-24T23:59:00.000Z',
  options: [
    { id: 'segunda', label: 'Segunda à noite', startsAt: '2026-08-24T23:00:00.000Z' },
    { id: 'terca', label: 'Terça à noite', startsAt: '2026-08-25T23:00:00.000Z' },
    { id: 'quarta', label: 'Quarta à noite', startsAt: '2026-08-26T23:00:00.000Z' },
  ],
}
const tiedResult = resolveSessionPollResult(poll, [
  { optionIds: ['segunda'] },
  { optionIds: ['terca'] },
  { optionIds: ['segunda'] },
  { optionIds: ['terca'] },
])
assert.equal(tiedResult.shouldClose, true)
assert.equal(tiedResult.targetMet, true)
assert.equal(tiedResult.kind, 'tie')
assert.deepEqual(tiedResult.winnerOptionIds, ['segunda', 'terca'])
const tiedPayload = sessionPollResultPayload(poll, tiedResult, { TIME_ZONE: 'America/Sao_Paulo' })
assert.equal(tiedPayload.embeds[0].description.includes('empatada'), true)
assert.equal(tiedPayload.embeds[0].description.includes('Segunda à noite'), true)
assert.equal(tiedPayload.embeds[0].description.includes('Terça à noite'), true)
assert.equal(tiedPayload.components, undefined)

const singleVoterResult = resolveSessionPollResult({ ...poll, targetVotes: 1 }, [{ optionIds: ['quarta'] }])
assert.equal(singleVoterResult.shouldClose, true)
assert.equal(singleVoterResult.kind, 'winner')
assert.deepEqual(singleVoterResult.winnerOptionIds, ['quarta'])
const singleVoterPayload = sessionPollResultPayload(
  { ...poll, targetVotes: 1 },
  singleVoterResult,
  { TIME_ZONE: 'America/Sao_Paulo' },
  'https://calendar.google.com/calendar/render?action=TEMPLATE',
)
assert.equal(singleVoterPayload.components[0].components[0].label, 'Adicionar ao Google Agenda')

const guildEmojis = [
  { id: '1537217597077200997', name: 'd20', animated: false },
  { id: '1537217597077200998', name: 'fogo', animated: true },
]

assert.deepEqual(resolveButtonEmoji(':d20:', guildEmojis), {
  id: '1537217597077200997', name: 'd20', animated: false,
})
assert.deepEqual(resolveButtonEmoji('<a:fogo:1537217597077200998>', guildEmojis), {
  id: '1537217597077200998', name: 'fogo', animated: true,
})
assert.deepEqual(resolveButtonEmoji('📜', guildEmojis), { name: '📜' })
assert.deepEqual(resolveButtonEmoji(':inexistente:', guildEmojis), { name: '🔗' })

const payload = directNotificationPayload({
  id: 'notification-test',
  reason: 'Leitura necessária',
  details: 'Consulte os materiais antes da próxima sessão.',
  subject: 'Personagem Aldren',
  decorationUrl: 'https://example.com/carta.gif',
  createdByName: 'Nome que não pode aparecer',
  links: [
    { label: 'Contexto', url: 'https://stasisrpg.web.app/sistemastasis', emoji: ':d20:' },
    { label: 'Portal', url: 'https://stasisrpg.web.app/login', emoji: '<a:fogo:1537217597077200998>' },
    { label: 'Inválido', url: 'javascript:alert(1)', emoji: '🔥' },
  ],
}, guildEmojis)

assert.equal(payload.components[0].components.length, 2)
assert.equal(payload.components[0].components[0].style, 5)
assert.deepEqual(payload.components[0].components[0].emoji, guildEmojis[0])
assert.equal(payload.components[0].components[1].emoji.animated, true)
assert.equal(JSON.stringify(payload).includes('Nome que não pode aparecer'), false)
assert.equal(payload.embeds[0].image.url, 'https://example.com/carta.gif')

const fallbackPayload = directNotificationPayload({
  id: 'notification-fallback', reason: 'Teste', details: 'Detalhes', subject: 'Referência',
  decorationUrl: 'javascript:alert(1)', links: [],
})
assert.equal(fallbackPayload.embeds[0].image.url.endsWith('.gif'), true)

const generalAlertPayload = directNotificationPayload({
  id: 'general-alert-test',
  sourceKind: 'general_alert',
  reason: 'Atenção, aventureiros',
  details: 'Uma notícia importante foi publicada.',
  subject: 'Comunicado importante para a comunidade',
  links: [
    { label: 'Desativar Notícias do RPG', url: 'https://stasisrpg.web.app/alertas/desativar?token=teste', emoji: '🔕' },
  ],
})
assert.equal(generalAlertPayload.content.includes('Alerta Importante'), true)
assert.equal(generalAlertPayload.embeds[0].color, 0xd3a64a)
assert.equal(generalAlertPayload.embeds[0].title.includes('⚠️'), true)
assert.equal(generalAlertPayload.components[0].components[0].label, 'Desativar Notícias do RPG')

const confirmation = {
  submittedAt: '2026-08-15T23:40:00.000Z',
  playerName: 'Aventureira',
  characterName: 'Elyra da Névoa',
  characterAge: '27',
  race: 'Eliatrope',
  className: 'Guardião',
  familyTribe: 'Uma família antiga de viajantes.',
  story: 'Uma história longa que deve permanecer completa no anexo.',
  advantages: [{ name: 'Coragem', points: 2 }],
  weaknesses: [{ name: 'Juramento', points: -2 }],
  availability: ['Noite'],
  trama: { id: 'begins', title: 'Begins' },
  portrait: {
    name: 'elyra.png',
    type: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  },
}
const portraitFile = submissionConfirmationPortraitFile(confirmation)
assert.equal(portraitFile.filename, 'retrato-elyra-da-nevoa.png')
assert.equal(portraitFile.contentType, 'image/png')
assert.equal(submissionConfirmationPortraitFile({ ...confirmation, portrait: null }), null)
const confirmationPayload = submissionConfirmationPayload(confirmation, portraitFile.filename)
assert.equal(confirmationPayload.content.includes('Stasis RPG - Ficha recebida'), true)
assert.equal(confirmationPayload.embeds[0].image.url, 'https://i.pinimg.com/originals/b2/4a/14/b24a14cd5109ef90223cfda09389c6e6.gif')
assert.equal(confirmationPayload.embeds[0].thumbnail.url, 'attachment://retrato-elyra-da-nevoa.png')
assert.equal(confirmationPayload.embeds[0].fields.some((field) => field.value.includes('Elyra da Névoa')), true)
assert.equal(JSON.stringify(confirmationPayload).includes(confirmation.story), false)
const confirmationAttachment = submissionConfirmationAttachment(confirmation, 'protocolo-teste')
assert.equal(confirmationAttachment.includes(confirmation.familyTribe), true)
assert.equal(confirmationAttachment.includes(confirmation.story), true)
assert.equal(confirmationAttachment.includes('protocolo-teste'), true)
const longStory = 'Capítulo sem cortes. '.repeat(600)
const longAttachment = submissionConfirmationAttachment({ ...confirmation, story: longStory }, 'protocolo-longo')
assert.equal(longAttachment.includes(longStory.trim()), true)
assert.equal(JSON.stringify(submissionConfirmationPayload({ ...confirmation, story: longStory })).includes(longStory), false)

const reminderQueries = []
const fetchBeforeReminderTest = globalThis.fetch
globalThis.fetch = async (url, init) => {
  assert.equal(String(url).endsWith('/documents:runQuery'), true)
  const query = JSON.parse(init.body).structuredQuery
  reminderQueries.push(query)
  return new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
try {
  const reminderResult = await runReminders({ FIREBASE_PROJECT_ID: 'stasisrpg' }, 'token-de-teste')
  assert.equal(reminderResult.ok, true)
  assert.equal(reminderResult.books, 0)
  assert.equal(reminderQueries.length, 2)
  assert.deepEqual(reminderQueries.map((query) => query.where.fieldFilter.op), [
    'LESS_THAN_OR_EQUAL',
    'LESS_THAN_OR_EQUAL',
  ])
  assert.deepEqual(reminderQueries.map((query) => query.limit), [25, 25])
  assert.equal(reminderQueries.every((query) => query.orderBy[0].direction === 'DESCENDING'), true)
} finally {
  globalThis.fetch = fetchBeforeReminderTest
}

const originalFetch = globalThis.fetch
const sentRequests = []
globalThis.fetch = async (url, init) => {
  assert.equal(String(url).endsWith('/channels/canal-teste/messages'), true)
  assert.equal(init.headers['content-type'], undefined)
  assert.equal(init.body instanceof FormData, true)
  sentRequests.push(init.body)
  return new Response(JSON.stringify({ id: `mensagem-${sentRequests.length}` }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
try {
  const sent = await sendSubmissionConfirmation(
    { DISCORD_BOT_TOKEN: 'token-de-teste' },
    'canal-teste',
    confirmation,
    'protocolo-teste',
  )
  assert.equal(sent.cardMessage.id, 'mensagem-1')
  assert.equal(sent.attachmentMessage.id, 'mensagem-2')
  assert.equal(sentRequests.length, 2)
  const cardMultipart = sentRequests[0]
  const cardPayload = JSON.parse(cardMultipart.get('payload_json'))
  assert.equal(cardPayload.attachments[0].filename, 'retrato-elyra-da-nevoa.png')
  assert.equal(cardPayload.embeds[0].thumbnail.url, 'attachment://retrato-elyra-da-nevoa.png')
  assert.equal((cardMultipart.get('files[0]')).type, 'image/png')
  const fileMultipart = sentRequests[1]
  const filePayload = JSON.parse(fileMultipart.get('payload_json'))
  assert.equal(filePayload.attachments[0].filename, 'ficha-elyra-da-nevoa.txt')
  assert.equal(filePayload.content.includes('História e tribo seguem no arquivo abaixo.'), true)
  assert.equal((fileMultipart.get('files[0]')).type, 'text/plain;charset=utf-8')
} finally {
  globalThis.fetch = originalFetch
}

console.log('Automação Discord: DMs manuais e confirmação automática da ficha aprovadas.')
