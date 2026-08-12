# Stasis RPG — lembretes autônomos do Discord

O núcleo executa na nuvem pelo GitHub Actions a cada cinco minutos. Ele não
depende do site estar aberto, do Codex, do Windows ou do computador do mestre.
O código deste diretório forma um repositório público mínimo; os tokens ficam
nos Secrets criptografados do GitHub e nunca aparecem no repositório.

## Segredos obrigatórios

Configure com `wrangler secret put`:

- `DISCORD_BOT_TOKEN`
- `FIREBASE_SERVICE_PASSWORD`
- `RUN_SECRET`

As variáveis públicas e o cron ficam em `wrangler.toml`. Nenhum segredo deve ser
commitado ou colocado no Firebase Hosting.

## Implantação atual (GitHub Actions gratuito)

O workflow está em `.github/workflows/reminders.yml`. O repositório não contém
qualquer conteúdo privado do site, somente o relógio. Ele pode ser disparado
manualmente pela aba Actions e também roda automaticamente por cron.

## Alternativa futura (Cloudflare Worker)

```powershell
cmd /c npx wrangler login
cmd /c npx wrangler secret put DISCORD_BOT_TOKEN
cmd /c npx wrangler secret put FIREBASE_SERVICE_PASSWORD
cmd /c npx wrangler secret put RUN_SECRET
cmd /c npx wrangler deploy
```

O usuário `stasis.reminders@stasisrpg.app` precisa existir no Firebase Auth e
ter um documento ativo `accessGrants/{uid}` com cargo `master`. Esse usuário é
exclusivo da automação; não use a conta pessoal do painel.

## Idempotência

O Worker reivindica cada aviso com `sessionReminder*ClaimedAt`, envia ao Discord
e grava `sessionReminder*SentAt` e `sessionReminder*MessageId`. Uma reivindicação
abandonada expira em dez minutos, permitindo recuperação automática.
