import assert from 'node:assert/strict'
import {
  directNotificationPayload,
  resolveButtonEmoji,
  sendSubmissionConfirmation,
  submissionConfirmationAttachment,
  submissionConfirmationPayload,
  submissionConfirmationPortraitFile,
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
