# Stasis RPG — automações autônomas do Discord

Este serviço executa integralmente online e não depende do site aberto, do Codex,
do Windows ou do computador do administrador. O Worker da Cloudflare é o relógio
principal e verifica a cada dois minutos:

- lembretes de sessão de 18 e 5 horas;
- notificações privadas criadas por mestres no site, incluindo botões com emoji
  e uma imagem ou GIF de decoração opcional.

O código é público e mínimo. Tokens, senhas e outras credenciais permanecem nos
segredos criptografados da Cloudflare. O GitHub Actions conserva uma cópia dos
segredos necessários e roda apenas como contingência horária ou manual.

## Produção

- Worker: `stasis-rpg-discord-reminders`
- Saúde: `https://stasis-rpg-discord-reminders.discord-reminders.workers.dev/health`
- Cron principal: `*/2 * * * *`
- Contingência GitHub: minuto 17 de cada hora e acionamento manual

O intervalo de dois minutos deixa margem para a meta operacional de processamento
em até cinco minutos. Uma indisponibilidade geral do provedor continua sendo uma
exceção possível, como em qualquer serviço externo.

## Segredos

- `DISCORD_BOT_TOKEN`
- `FIREBASE_API_KEY`
- `FIREBASE_SERVICE_EMAIL`
- `FIREBASE_SERVICE_PASSWORD`

Na Cloudflare também existe `RUN_SECRET`, usado somente pelo endpoint protegido
de diagnóstico. Valores sensíveis nunca devem ser colocados no `wrangler.toml`.

O usuário técnico `Stasis Reminder Service` possui acesso estritamente identificado
nas regras do Firestore. Apenas ele pode mover notificações de `pending` para
`processing`, `sent` ou `failed`.

## Idempotência

Lembretes e DMs são reivindicados antes do envio. Uma reivindicação abandonada
expira em dez minutos e pode ser retomada. DMs também usam o ID do evento como nonce
do Discord. O bridge do Windows não processa mais essa fila; ele conserva somente
a inspeção para diagnóstico, evitando concorrência entre computador e nuvem.

## Execução

O cron principal está em `wrangler.toml`. O workflow de contingência está em
`.github/workflows/reminders.yml` e também pode ser disparado manualmente.
`node run.mjs` usa as mesmas variáveis do workflow.

Os segredos do Worker nunca devem ser incluídos no repositório.
