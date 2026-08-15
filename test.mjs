import assert from 'node:assert/strict'
import { directNotificationPayload, resolveButtonEmoji } from './src/index.js'

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
assert.equal(payload.embeds[0].image.url.endsWith('.gif'), true)

console.log('Automação Discord: payload, links e emojis personalizados aprovados.')
