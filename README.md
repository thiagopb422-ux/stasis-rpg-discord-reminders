# Stasis RPG — automações autônomas do Discord

Este serviço executa integralmente online e não depende do site aberto, do Codex,
do Windows ou do computador do administrador. O GitHub Actions verifica a cada
cinco minutos:

- lembretes de sessão de 18 e 5 horas;
- notificações privadas criadas por mestres no site.

O código é público e mínimo. Tokens, senhas e outras credenciais permanecem nos
GitHub Encrypted Secrets.

## Segredos do GitHub

- `DISCORD_BOT_TOKEN`
- `FIREBASE_API_KEY`
- `FIREBASE_SERVICE_EMAIL`
- `FIREBASE_SERVICE_PASSWORD`

O usuário técnico `Stasis Reminder Service` possui acesso estritamente identificado
nas regras do Firestore. Apenas ele pode mover notificações de `pending` para
`processing`, `sent` ou `failed`.

## Idempotência

Lembretes e DMs são reivindicados antes do envio. Uma reivindicação abandonada
expira em dez minutos e pode ser retomada. DMs também usam o ID do evento como nonce
do Discord. O bridge do Windows não processa mais essa fila; ele conserva somente
a inspeção para diagnóstico, evitando concorrência entre computador e nuvem.

## Execução

O workflow está em `.github/workflows/reminders.yml` e também pode ser disparado
manualmente. `node run.mjs` usa as mesmas variáveis do workflow.

O `wrangler.toml` mantém uma alternativa compatível com Cloudflare Worker caso o
agendador seja migrado no futuro. Os segredos do Worker nunca devem ser incluídos
no repositório.
