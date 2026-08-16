import { runAutomation } from './src/index.js'

const required = ['FIREBASE_API_KEY', 'FIREBASE_SERVICE_EMAIL', 'FIREBASE_SERVICE_PASSWORD', 'DISCORD_BOT_TOKEN', 'SUBMISSION_CONFIRMATION_PRIVATE_KEY']
for (const name of required) {
  if (!process.env[name]) throw new Error(`Variável obrigatória ausente: ${name}`)
}

const result = await runAutomation({
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'stasisrpg',
  FIREBASE_API_KEY: process.env.FIREBASE_API_KEY,
  FIREBASE_SERVICE_EMAIL: process.env.FIREBASE_SERVICE_EMAIL,
  FIREBASE_SERVICE_PASSWORD: process.env.FIREBASE_SERVICE_PASSWORD,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  SUBMISSION_CONFIRMATION_PRIVATE_KEY: process.env.SUBMISSION_CONFIRMATION_PRIVATE_KEY,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || '1019386388602425365',
  TIME_ZONE: process.env.TIME_ZONE || 'America/Sao_Paulo',
})

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
