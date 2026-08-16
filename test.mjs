import assert from 'node:assert/strict'
import {
  directNotificationPayload,
  resolveButtonEmoji,
  sendDiscordAttachment,
  submissionConfirmationAttachment,
  submissionConfirmationPayload,
} from './src/index.js'

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
}
const confirmationPayload = submissionConfirmationPayload(confirmation)
assert.equal(confirmationPayload.content.includes('Stasis RPG - Ficha recebida'), true)
assert.equal(confirmationPayload.embeds[0].image.url, 'https://i.pinimg.com/originals/b2/4a/14/b24a14cd5109ef90223cfda09389c6e6.gif')
assert.equal(confirmationPayload.embeds[0].fields.some((field) => field.value.includes('Elyra da Névoa')), true)
assert.equal(JSON.stringify(confirmationPayload).includes(confirmation.story), false)
const confirmationAttachment = submissionConfirmationAttachment(confirmation, 'protocolo-teste')
assert.equal(confirmationAttachment.includes(confirmation.familyTribe), true)
assert.equal(confirmationAttachment.includes(confirmation.story), true)
assert.equal(confirmationAttachment.includes('protocolo-teste'), true)
const longStory = 'Capítulo sem cortes. '.repeat(600)
const longAttachment = submissionConfirmationAttachment({ ...confirmation, story: longStory }, 'protocolo-longo')
assert.equal(longAttachment.includes(longStory), true)
assert.equal(JSON.stringify(submissionConfirmationPayload({ ...confirmation, story: longStory })).includes(longStory), false)

const originalFetch = globalThis.fetch
let multipartChecked = false
globalThis.fetch = async (url, init) => {
  assert.equal(String(url).endsWith('/channels/canal-teste/messages'), true)
  assert.equal(init.headers['content-type'], undefined)
  assert.equal(init.body instanceof FormData, true)
  const multipartPayload = JSON.parse(init.body.get('payload_json'))
  assert.equal(multipartPayload.attachments[0].filename, 'ficha-elyra.txt')
  assert.equal((init.body.get('files[0]')).type, 'text/plain;charset=utf-8')
  multipartChecked = true
  return new Response(JSON.stringify({ id: 'mensagem-teste' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
try {
  const sent = await sendDiscordAttachment(
    { DISCORD_BOT_TOKEN: 'token-de-teste' },
    'canal-teste',
    confirmationPayload,
    'ficha-elyra.txt',
    confirmationAttachment,
  )
  assert.equal(sent.id, 'mensagem-teste')
  assert.equal(multipartChecked, true)
} finally {
  globalThis.fetch = originalFetch
}

console.log('Automação Discord: DMs manuais e confirmação automática da ficha aprovadas.')
