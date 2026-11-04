# Evo CRM MCP

Servidor [MCP](https://modelcontextprotocol.io/) em TypeScript para conectar assistentes à API REST `/api/v1` do **Evo AI CRM Community**. Oferece stdio local e Streamable HTTP stateless, com escopos de leitura e escrita separados.

O alvo é a API da branch `main` do upstream [evolution-foundation/evo-ai-crm-community](https://github.com/evolution-foundation/evo-ai-crm-community), inspecionada em 23/10/2026 no commit **`30fcb61dd824aa5b74e01467001f58cc90c2281f`**. Os contratos foram conferidos em [config/routes.rb](https://github.com/evolution-foundation/evo-ai-crm-community/blob/30fcb61dd824aa5b74e01467001f58cc90c2281f/config/routes.rb) e [app/controllers/api/v1](https://github.com/evolution-foundation/evo-ai-crm-community/tree/30fcb61dd824aa5b74e01467001f58cc90c2281f/app/controllers/api/v1), com apoio dos helpers, serializers e finders desse mesmo commit. Não depende de endpoints exclusivos de forks. O client Python `int-evo-crm` serviu apenas de referência auxiliar de payloads.

## Novidades da 0.3.0

- **Administração do CRM**: criar e editar funis (etapas e campos dos cards), etapas, campos dos cards, tarefas (editar, cancelar, reabrir), etiquetas e campos personalizados de contato/conversa.
- **Servidor OAuth 2.1** (`oauth-server.mjs`, `npm run start:oauth`): conector para Claude, ChatGPT/Codex e Grok, com tela de senha (`CONNECTOR_PASSWORD_SCRYPT_FILE`), `PUBLIC_URL` e `MCP_ORG_NAME`. `MCP_DISABLED_TOOLS` desliga ferramentas (ex.: `message_send`).
- **Endpoints internos para agentes nativos do CRM** (só rede interna; pelo proxy reverso, com `X-Forwarded-For`, a chamada é recusada):
  - `/agente/mcp` (`AGENT_TOKEN_FILE`): agente de e-mails → `emails_processar`, `publicacoes_listar`;
  - `/atendimento/mcp` (`ATTENDANCE_TOKEN_FILE`): agente de atendimento → `enviar_alerta_equipe`, `pedir_aprovacao`, `nota_contato_criar`.
  No agente, use "MCP personalizado" com a URL interna e o cabeçalho `Authorization: Bearer <token>`.

### Módulo opcional: equipe (alertas, escalonamento e aprovações)
Liga com `TEAM_INBOX_ID` (caixa de WhatsApp) e `TEAM_MEMBERS=chave:5511...:Nome,...`. Destinos são uma **lista fixa**; `TEAM_BLOCKED_NUMBERS` nunca recebe nada.
- `alerta_whatsapp_enviar` (conector) e `enviar_alerta_equipe` (agente). Alerta para `TEAM_ESCALATE_FROM` pede **CIENTE**; sem resposta em `TEAM_ESCALATE_MINUTES` (15), vai sozinho para `TEAM_ESCALATE_TO`.
- `pedir_aprovacao`: manda ao `TEAM_APPROVER` a resposta proposta com um código (`#C1234`). Ele responde `1 #C1234` (enviar), `2 #C1234 texto` (enviar ajustado) ou `3 #C1234` (ele responde); a decisão é aplicada na conversa do cliente em até 1 min. Pedidos expiram em 48 h sem envio.
- Contatos da equipe recebem a etiqueta `TEAM_LABEL` (`equipe`): coloque-a em "etiquetas ignoradas" do agente da caixa para ele não responder à equipe.

### Módulo opcional: monitor jurídico (Brasil)
Liga com `LEGAL_MONITOR=true`. Fontes gratuitas: DJEN/CNJ por OAB (`DJEN_OAB`, `DJEN_UF`; a API só aceita IP brasileiro, então use `DJEN_PROXY_URL` + `DJEN_PROXY_KEY_FILE` com um proxy no Brasil) e e-mails da caixa `LEGAL_EMAIL_INBOX_ID` (Jusbrasil, PJe push, Escavador, Recorte Digital OAB, tribunais `*.jus.br`).
- Deduplica por CNJ + data de disponibilização + tipo do ato; acha o cliente pelo processo vinculado ou pelo nome exato das partes.
- Cria (se não existir) o funil **Prazos e publicações** (Nova → Prazo calculado → Em elaboração → Protocolado → Arquivado): um card por cliente (o CRM só permite um card ativo por contato e funil) e **uma tarefa por publicação** — "Calcular prazo" ou, para movimentação sem intimação, "Conferir no PJe". Publicações sem cliente ficam no contato `LEGAL_UNLINKED_CONTACT_NAME`.
- `prazo_registrar` grava o prazo calculado na tarefa, move o card e devolve o evento sugerido para a agenda (2 dias e 4 h antes).
- Resumo por WhatsApp (módulo equipe) em dias úteis às `LEGAL_DIGEST_TIME` (07:30), só com novidade, com lembrete do painel do PJe em `LEGAL_PJE_REMINDER_WEEKDAYS` (segunda e quinta).
- E-mails automáticos são arquivados (resolvidos, nunca apagados); e-mails de pessoas ficam abertos; `LEGAL_OWN_EMAILS` marca relatórios internos.
- Opcional: `POSVENDA_PIPELINE_ID` + `STAGE_*` movem o card do cliente no funil de relacionamento conforme o tipo de ato.

Recomendação para agentes nativos de e-mail: o Evo CRM envia a resposta do agente como e-mail ao remetente. Use um fork que transforme a saída do agente em nota privada em caixas de e-mail (ver `evo-ai-crm-community`, `Message#force_private_for_silent_bot`).

## Instalação

Requisitos: Node.js 20 ou superior e npm.

```bash
npm ci
npm run build
npm test
cp .env.example .env
```

Preencha `.env` apenas no seu ambiente local. Os processos usam variáveis de ambiente; não carregam `.env` automaticamente. Para usar o arquivo diretamente com Node 20.6+:

```bash
node --env-file=.env dist/stdio.js
# ou
node --env-file=.env dist/http.js
```

Com variáveis já exportadas, use `npm start` (stdio, padrão) ou `npm run start:http`. Não execute stdio em um terminal esperando uma interface: ele recebe JSON-RPC por stdin e reserva stdout para o protocolo.

## Variáveis

| Nome | Uso |
| --- | --- |
| `EVOCRM_BASE_URL` | Obrigatória. Origem do CRM, por exemplo `https://crm.example.com`, sem caminho, query ou credenciais. |
| `EVOCRM_API_TOKEN` | Obrigatória. Token do CRM enviado exclusivamente ao CRM no header `api_access_token`. |
| `MCP_SCOPE` | stdio: `read` (padrão) ou `write`. HTTP determina o escopo pelo bearer, ignorando esta variável. |
| `MCP_TOKEN_SHA256_READ` | HTTP: hash SHA-256 hexadecimal de um token próprio para leitura. |
| `MCP_TOKEN_SHA256_WRITE` | HTTP: hash SHA-256 hexadecimal de outro token próprio para escrita. |
| `PORT` | Porta HTTP, padrão `3000`. Escuta em `0.0.0.0`. |
| `MCP_ALLOWED_ORIGINS` | Origens exatas separadas por vírgulas, por exemplo `https://assistant.example.com`. Vazio rejeita requisições com `Origin`; clientes sem esse header continuam sujeitos ao bearer. |

HTTP exige pelo menos um dos hashes. Se ambos forem definidos, devem representar tokens distintos. `write` também inclui leitura. A autenticação usa `crypto.timingSafeEqual` sobre o digest SHA-256; falhas retornam `401` com `WWW-Authenticate: Bearer`. O token próprio do MCP e o token da API CRM são credenciais diferentes.

Para gerar o hash de um bearer **já presente no ambiente**, sem imprimir o bearer:

```bash
node -e 'const c = require("node:crypto"); if (!process.env.MCP_BEARER_TOKEN) process.exit(1); console.log(c.createHash("sha256").update(process.env.MCP_BEARER_TOKEN).digest("hex"))'
```

Configure esse hash na variável do escopo desejado e mantenha o bearer original somente nos clientes autorizados. Use tokens aleatórios fortes e HTTPS ao expor HTTP fora da máquina. Rotacione o bearer e seu hash para revogar acesso. Cada processo aponta para uma única origem e usa uma única credencial CRM; os escopos MCP não substituem as permissões dessa credencial no CRM.

## Claude Code

Depois de exportar as variáveis no terminal, registre stdio com o caminho absoluto do build. O comando abaixo grava a configuração no escopo de usuário do Claude Code; mantenha essa configuração privada:

```bash
claude mcp add \
  --env "EVOCRM_BASE_URL=$EVOCRM_BASE_URL" \
  --env "EVOCRM_API_TOKEN=$EVOCRM_API_TOKEN" \
  --env MCP_SCOPE=read \
  --transport stdio --scope user evocrm \
  -- node /CAMINHO/ABSOLUTO/evocrm-mcp/dist/stdio.js
```

Para HTTP, inicie o servidor com os hashes configurados e use o **bearer original do MCP**, nunca o token CRM:

```bash
claude mcp add --transport http --scope user evocrm-http \
  https://mcp.example.com/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

Confira a conexão com `/mcp` no Claude Code. A sintaxe está descrita na [documentação oficial do Claude Code](https://code.claude.com/docs/en/mcp).

## Codex

Em `~/.codex/config.toml`, configure stdio e repasse as credenciais do ambiente do processo que inicia o Codex:

```toml
[mcp_servers.evocrm]
command = "node"
args = ["/CAMINHO/ABSOLUTO/evocrm-mcp/dist/stdio.js"]
env_vars = ["EVOCRM_BASE_URL", "EVOCRM_API_TOKEN"]
env = { MCP_SCOPE = "read" }
```

Ou configure HTTP:

```toml
[mcp_servers.evocrm_http]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "MCP_BEARER_TOKEN"
```

Exporte `MCP_BEARER_TOKEN` antes de iniciar o Codex. Esses campos seguem a [documentação oficial OpenAI sobre MCP no Codex](https://developers.openai.com/codex/mcp). Use apenas o transporte desejado para evitar tools duplicadas.

## Tools

No escopo `read`, são registradas somente as 17 tools de leitura. `write` registra as 46 tools base (mais as dos módulos opcionais, se configurados). Todos os argumentos e descrições estão em pt-BR; IDs são strings obtidas nas consultas.

| Tool | Escopo | Endpoint relativo a `/api/v1` |
| --- | --- | --- |
| `contacts_list` | read | `GET /contacts` |
| `contacts_search` | read | `GET /contacts/search?q=...` |
| `contact_get` | read | `GET /contacts/:contact_id`; opcionalmente `GET /contacts/:contact_id/notes` |
| `contact_create` | write | `POST /contacts` |
| `contact_update` | write | `PUT /contacts/:contact_id` |
| `contact_note_add` | write | `POST /contacts/:contact_id/notes` |
| `conversations_list` | read | `GET /conversations` |
| `conversation_get` | read | `GET /conversations/:conversation_id` |
| `messages_list` | read | `GET /conversations/:conversation_id/messages` |
| `message_send` | write | `POST /conversations/:conversation_id/messages` |
| `conversation_assign` | write | `POST /conversations/:conversation_id/assignments` |
| `conversation_set_status` | write | `POST /conversations/:conversation_id/toggle_status` |
| `labels_add` | write | `GET` e `POST /contacts/:entity_id/labels` ou `/conversations/:entity_id/labels` |
| `pipelines_list` | read | `GET /pipelines` |
| `pipeline_get` | read | `GET /pipelines/:pipeline_id` |
| `pipeline_items_list` | read | `GET /pipelines/:pipeline_id/pipeline_items` |
| `pipeline_item_create` | write | `POST /pipelines/:pipeline_id/pipeline_items` |
| `pipeline_item_move` | write | `PATCH /pipelines/:pipeline_id/pipeline_items/:pipeline_item_id/move_to_stage` |
| `pipeline_item_update` | write | `PATCH /pipelines/:pipeline_id/pipeline_items/:pipeline_item_id` |
| `tasks_list` | read | `GET /pipelines/:pipeline_id/pipeline_items/:pipeline_item_id/tasks` |
| `task_create` | write | `POST /pipelines/:pipeline_id/pipeline_items/:pipeline_item_id/tasks` |
| `task_complete` | write | `POST /pipelines/:pipeline_id/pipeline_tasks/:task_id/complete` |
| `inboxes_list` | read | `GET /inboxes` |
| `agents_list` | read | `GET /agents` |
| `labels_list` / `label_create` | read / write | `GET` e `POST /labels` |
| `custom_attributes_list` / `custom_attribute_create` | read / write | `GET` e `POST /custom_attribute_definitions` |
| `pipeline_create` / `pipeline_update` | write | `POST /pipelines` (com `stages`) / `PATCH /pipelines/:id` — `card_fields` vira `custom_fields` do funil |
| `pipeline_stage_create` / `_update` / `_delete` | write | `/pipelines/:id/pipeline_stages[/:stage_id]` |
| `pipeline_item_custom_fields_update` / `pipeline_item_delete` | write | `PATCH .../pipeline_items/:id/update_custom_fields` / `DELETE .../pipeline_items/:id` |
| `task_update` / `task_cancel` / `task_reopen` | write | `PATCH .../pipeline_tasks/:id`, `POST .../cancel`, `POST .../reopen` |
| `message_templates_list` / `message_template_get` / `_create` / `_delete` / `message_templates_sync` | read / write | modelos do WhatsApp Cloud por caixa |
| `conversation_reply_window` / `template_send` / `conversation_start_with_template` | read / write | janela de 24 h e envio de modelo aprovado |

`contacts_list`, `contacts_search`, `conversations_list` e `inboxes_list` enviam `page` e `per_page` ao CRM. `agents_list` envia também `skip`, `limit` e `pageSize` ao proxy de IA. O padrão é `page=1`, `limit=20`, com máximo de 100. O servidor sempre recorta a coleção ao limite solicitado e indica `truncated` se o upstream o ignorar. Nesse caso, confira `upstream_meta` antes de avançar, pois a instalação pode usar tamanho de página diferente.

Pipelines, itens, tarefas e notas não têm paginação no upstream consultado: o MCP aplica `page`/`limit` localmente e retorna `total`/`next_page`. Isso limita a saída da tool, mas a resposta completa ainda trafega do CRM até o MCP. Objetos aninhados, como subtarefas, não são paginados. `pipeline_get` retorna o quadro completo do upstream; prefira `pipeline_items_list` para uma coleção recortada.

`messages_list` preserva a paginação nativa por cursor, com `limit` entre 1 e 20 e `page` fixo em 1. Use `next_before` para mensagens anteriores e `next_after` para posteriores; não envie ambos. Os cursores representam os extremos da página retornada. Uma página vazia indica o fim naquele sentido. Sem cursor, retorna as mensagens mais recentes em ordem cronológica.

Respostas MCP contêm JSON no bloco `content` de texto. Coleções usam `{ items, pagination, upstream_meta }`; consultas individuais preservam `{ data, meta }` quando disponíveis. O envelope CRM `{ success: true, data: ... }` é normalizado; erros são `isError: true`, com mensagem em pt-BR e sem refletir corpos remotos.

## Diferenças conhecidas

- Os 24 endpoints deste corte existem no upstream fixado. Não foi necessário manter nenhuma dependência do fork auditado anteriormente. Instalações derivadas de versões antigas podem divergir nos payloads, permissões e paginação.
- O [controller de notas](https://github.com/evolution-foundation/evo-ai-crm-community/blob/30fcb61dd824aa5b74e01467001f58cc90c2281f/app/controllers/api/v1/contacts/notes_controller.rb) exige `{ note: { content } }`, enquanto o client Python de referência envia `content` na raiz. Esta implementação segue o upstream.
- Criar item usa `{ type, item_id, pipeline_stage_id, custom_fields? }`; mover usa `{ new_stage_id, notes? }`. Não usa o exemplo simplificado `contact_id`/`stage_id` do client Python.
- Tarefas são vinculadas a um item de pipeline, criadas dentro de `{ task: ... }` e concluídas por `/pipeline_tasks/:id/complete`. A conclusão afeta também descendentes. Não existe uma lista global `/tasks` neste corte.
- `/agents` é um proxy para agentes **de IA** do evo-core, com permissão `ai_agents.read` no upstream atual. Não fornece IDs de atendentes humanos para `conversation_assign`; obtenha esses IDs pela administração do CRM. O fork anterior usava a permissão `agents.read` nesse controller.
- No upstream atual, `pipelines_list` inclui etapas sem carregar seus itens; o quadro completo está em `pipeline_get`. O fork anterior incluía os itens na listagem. `pipeline_item_update` pode persistir notas sem trocar de etapa; o fork anterior condicionava esse comportamento à mudança de etapa.
- O endpoint de labels **substitui** a lista. `labels_add` consulta as labels atuais, une os títulos sem duplicatas e então grava. O upstream não oferece atualização atômica para essa união: uma alteração concorrente pode ser sobrescrita. Use títulos; a resolução de UUIDs depende da versão do CRM.
- A atribuição aceita exatamente um entre `assignee_id` e `team_id`, inclusive `null` para remover. No upstream atual, um ID não encontrado gera erro e preserva a atribuição; o fork anterior podia remover o atendente silenciosamente.
- Mensagens usam `before`/`after`, não `page`/`per_page`. O upstream ignora o limite solicitado e trabalha com janelas próprias; o MCP recorta a janela sem avançar além dos itens efetivamente devolvidos.

## Exemplos de pedidos

- “Liste duas caixas de entrada disponíveis.”
- “Busque o contato pelo identificador que informei e mostre somente o necessário.”
- “Quais pipelines e etapas estão disponíveis?”
- “Liste as tarefas pendentes deste item de pipeline.”
- Com escrita habilitada: “Adicione esta nota ao contato selecionado.”
- Com escrita habilitada: “Envie o texto aprovado nesta conversa como mensagem de saída.”

## HTTP e Docker

O endpoint é `POST /mcp`. `GET /mcp` retorna `405` com `Allow: POST`. `OPTIONS` permite preflight para origens autorizadas. Não há sessão persistente nem SSE de GET: cada POST cria um `McpServer` e um `WebStandardStreamableHTTPServerTransport` com `sessionIdGenerator: undefined` e `enableJsonResponse: true`, encerrados ao fim da requisição. A autenticação e a seleção de tools são refeitas a cada POST.

```bash
docker build -t evocrm-mcp .
docker run --rm --env-file .env -p 127.0.0.1:3000:3000 evocrm-mcp
```

A imagem multi-stage compila TypeScript, instala somente dependências de produção na etapa final e executa `npm run start:http` como usuário `node`. Arquivos `.env` são excluídos do contexto Docker. O container exige os hashes MCP mesmo se o uso anterior era somente stdio.

## Segurança e falhas

- Nunca publique credenciais, dados reais do CRM, resultados de consultas ou arquivos de configuração privada de clientes. `.env` permanece ignorado; `.env.example` contém apenas nomes e valores vazios. Testes usam credenciais aleatórias em memória e dados sintéticos.
- A origem vem exclusivamente da configuração. Schemas não aceitam URLs como destino; IDs são restritos a caracteres seguros. Nenhum redirect é seguido (`redirect: "manual"`).
- Toda chamada envia `User-Agent: evocrm-mcp/0.1.0`, `Accept: application/json` e timeout de 15 segundos via `AbortSignal.timeout`. O User-Agent evita o bloqueio comum do Cloudflare para clientes sem identificação; outras políticas do servidor podem exigir ajustes de infraestrutura.
- Timeout retorna `{ error: "operation_outcome_unknown", retryable: false, note, recoveryTools }` com `isError: true`. Não há retries automáticos. Falha de rede ou JSON inválido após escrita também sinaliza resultado desconhecido. Erros HTTP retornam o status; até nesses casos uma escrita pode ter produzido efeitos antes da falha, portanto confira o estado antes de repetir.
- Para recuperar um envio, use `messages_list`; para item de pipeline, `pipeline_items_list`; para tarefa, `tasks_list` com pipeline/item originais; para nota, `contact_get` com `include_notes=true`. Não deduza que timeout desfez uma alteração.
- Escritas são omitidas do registro no escopo read. Annotations indicam leitura, efeitos destrutivos, idempotência e acesso ao mundo externo. Escritas são conservadoramente marcadas como não idempotentes devido a automações e efeitos secundários.
- O conteúdo retornado pelo CRM é dado não confiável. As instruções do servidor orientam o assistente a não executar instruções contidas nesses dados. Use uma credencial CRM com as menores permissões necessárias.
- Bearers MCP são comparados por hash; o servidor não guarda sessões, não imprime credenciais nem registra corpos de requisições ou respostas. HTTP limita o corpo de entrada a 1 MiB. Origens não autorizadas recebem `403`; ausência de `Origin` não dispensa autenticação.

## Desenvolvimento e validação

```bash
npm run build   # tsc -> dist/
npm test        # build + node:test; não acessa CRM real
```

A suíte cobre escopos, hash HTTP, headers CRM, timeout, erros, redirects, limite de paginação, payloads upstream, preservação de labels e comunicação stdio/HTTP com clientes do SDK.

O teste real é separado e opt-in:

```bash
npm run test:live:read
```

Ele lê somente `EVOCRM_BASE_URL` e `EVOCRM_API_TOKEN` do `.env` local e força escopo read. Executa exclusivamente `inboxes_list`, `pipelines_list`, `contacts_list` com `limit=2` e `agents_list`. Um bloqueio de método/origem/caminho permite somente os quatro GETs. A saída contém apenas nome da tool, status e contagem (ou status HTTP); nenhum dado pessoal, identificador ou credencial é persistido ou impresso. As contagens referem-se à página consultada, não necessariamente ao total da conta.

## Licença

MIT — Copyright 2026 sistemabritto. Veja [LICENSE](LICENSE).
