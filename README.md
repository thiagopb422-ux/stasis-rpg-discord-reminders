# Stasis RPG — automações autônomas do Discord

Este serviço executa integralmente online e não depende do site aberto, do Codex,
do Windows ou do computador do administrador. O Worker da Cloudflare é o relógio
principal e verifica a cada minuto, sempre com consultas filtradas e limitadas:

- lembretes de sessão de 18 e 5 horas;
- encerramento das votações de agenda assim que todos os jogadores esperados
  respondem, incluindo resultados empatados, ou quando o prazo termina;
- notificações privadas criadas por mestres no site, incluindo botões com emoji
  e uma imagem ou GIF de decoração opcional.
- confirmações automáticas de fichas, enviadas após a espera mínima de um minuto,
  com resumo em embed, a primeira foto como miniatura e a ficha completa em uma
  segunda mensagem com arquivo de texto anexado.
- alertas gerais excepcionais, enviados em lotes seguros de até 50 DMs por minuto,
  com notícia vinculada e opção individual de desativar futuros comunicados.
- comando visual `/r`, com D4, D6, D8, D10, D12, D20 e D100 em imagens 3D azuis
  e brancas, título opcional após `@`, vários dados e modificador numérico.

O código é público e mínimo. Tokens, senhas e outras credenciais permanecem nos
segredos criptografados da Cloudflare. O GitHub Actions conserva uma cópia dos
segredos necessários e roda apenas como contingência horária ou manual.

## Produção

- Worker: `stasis-rpg-discord-reminders`
- Saúde: `https://stasis-rpg-discord-reminders.discord-reminders.workers.dev/health`
- Cron principal: `* * * * *`
- Contingência GitHub: minuto 17 de cada hora e acionamento manual

O intervalo de um minuto permite que a confirmação seja entregue normalmente
entre um e dois minutos após o envio. Uma indisponibilidade geral do provedor
continua sendo uma exceção possível, como em qualquer serviço externo.

As filas não são varridas por inteiro. Notificações diretas e confirmações são
consultadas somente nos estados pendente ou em processamento, em lotes limitados.
Os lembretes consultam separadamente apenas os horários já vencidos e também usam
um teto por estágio. As agendas consultam somente votações abertas, no máximo 25
por execução, e leem apenas os votos vinculados a cada votação. A antiga tarefa agendada do Windows não faz parte da entrega
online e deve permanecer desativada.

## Preferências dos alertas gerais

Cada destinatário recebe um botão exclusivo para desativar notícias. O site pede
o mesmo usuário do Discord e o Worker compara somente a impressão SHA-256 desse
contato com um token aleatório de uso individual. A preferência não apaga ficha,
personagem ou conta: ela cria uma supressão permanente apenas para alertas gerais.
O Worker confere a supressão outra vez imediatamente antes de cada DM.

## Segredos

- `DISCORD_BOT_TOKEN`
- `FIREBASE_API_KEY`
- `FIREBASE_SERVICE_EMAIL`
- `FIREBASE_SERVICE_PASSWORD`
- `SUBMISSION_CONFIRMATION_PRIVATE_KEY`
- `DISCORD_PUBLIC_KEY`
- `DICE_IMAGE_SECRET`
- `DICE_SETUP_SECRET`

O Worker também usa o binding KV `DICE_PREFERENCES`. Ele guarda somente a
escolha visual de cada usuário (`cosmic` ou `blue`); não armazena resultados.

Na Cloudflare também existe `RUN_SECRET`, usado somente pelo endpoint protegido
de diagnóstico. Valores sensíveis nunca devem ser colocados no `wrangler.toml`.

## Oráculo dos Dados

O Discord encaminha o comando `/r` diretamente para
`/discord/interactions`; cada requisição é validada pela assinatura Ed25519 da
aplicação antes de qualquer rolagem. O comando aceita, por exemplo:

- `d20@Lance de Percepção`
- `2d6@Dano da Espada`
- `d8+3@Teste de Agilidade`
- `3d20+1d8@Ataque combinado`
- `d100@Descoberta de Tesouro`

São permitidos até seis dados somados entre todas as categorias por comando, inclusive D100. O resultado usa
aleatoriedade criptográfica e gera uma URL curta assinada para a imagem. A rota
de imagem combina os arquivos RGBA estáticos e entrega um PNG com cache
imutável; ela não consulta o Firebase e não depende do cron.

O conjunto visual `polyhedral_3d_blue_and_white` veio do DiscordDiceBot. Créditos
e licença estão preservados em `THIRD_PARTY_LICENSES`.

O conjunto padrão é o `Cósmico`: D4, D6, D8, D10, D12 e D20 possuem faces próprias em
`public/dice/source/cosmic-compact` e derivados RGBA em `public/dice/raw/cosmic`.
O conjunto completo `Redpill` segue o mesmo contrato em `redpill-compact` e
`raw/redpill`. Em ambos, o D100 é representado por dois D10 para dezenas e
unidades. `/personalizar` permite ao usuário alternar entre `Cósmico`, `Redpill`
e `Azul`, com persistência gratuita no KV. A rota pública `/dice/combat-roll`
fornece o D20 seguro do battlemap e mantém no Firestore somente as 20 rolagens
recentes de cada mesa ativa.

As faces compactas usam conteúdo máximo de 84 × 84 dentro de uma tela transparente
de 100 × 100. `scripts/validate_cosmic_assets.py` garante dimensões, derivados RGBA
e pelo menos oito pixels de margem nos conjuntos Cósmico e Redpill, evitando cortes
na composição do Discord. Os
extratores também validam o maior componente de cada célula antes da compactação;
se uma divisão da folha atravessar um dado, a geração falha em vez de publicar uma
face aparentemente segura que já nasceu incompleta.

O usuário técnico `Stasis Reminder Service` possui acesso estritamente identificado
nas regras do Firestore. Apenas ele pode mover notificações de `pending` para
`processing`, `sent` ou `failed`.

## Idempotência

Lembretes e DMs são reivindicados antes do envio. A fila de confirmação guarda o
conteúdo cifrado com uma chave própria e o elimina assim que termina a tentativa.
Uma reivindicação abandonada
expira em dez minutos e pode ser retomada. DMs também usam o ID do evento como nonce
do Discord. O bridge do Windows não processa mais essa fila; ele conserva somente
a inspeção para diagnóstico, evitando concorrência entre computador e nuvem.

## Execução

O cron principal está em `wrangler.toml`. O workflow de contingência está em
`.github/workflows/reminders.yml` e também pode ser disparado manualmente.
`node run.mjs` usa as mesmas variáveis do workflow.

Os segredos do Worker nunca devem ser incluídos no repositório.
