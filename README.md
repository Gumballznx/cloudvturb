<p align="center">
  <img src="assets/logo-512x512.png" alt="Logo CloudVTurb" width="140" height="140">
</p>

<h1 align="center">CloudVTurb</h1>

<p align="center">
  Plataforma SaaS de hospedagem e streaming de VSLs (Video Sales Letters) de alta conversao, otimizada para servidores dedicados, VPS e auto-hospedagem (self-hosting).
</p>

---

## Recursos Principais

- Dashboard SaaS Completo:
  - Visao geral com metricas agregadas: visualizacoes de pagina, reproducoes unicas, retencao media, cliques em CTA e monitoramento de cota de disco.
  - Gestao de pastas e videos com busca instantanea e ordenacao dinamica.
  - Editor visual completo de VSL com Live Preview (Desktop e Mobile).
  - Gerador de codigo embed responsivo para WordPress, Elementor, Webflow e HTML estatico.
  - Gestao de equipe (membros convidados) e controle de usuarios para o Administrador.
  - Sistema de Webhooks compativel com assinaturas HMAC SHA-256.
  - Documentacao interativa da API do Analytics.

- Player Ultra-Rapido e Otimizado para Conversao:
  - Smart Autoplay com barra animada e ativacao de audio inteligente.
  - Pitch Delay com surgimento programado de CTA e elementos de checkout.
  - Barra de progresso com aceleracao visual e bloqueio de avanco.
  - Retomada automatica da reproducao via armazenamento local.
  - Protecao contra clique com botao direito e atalhos de inspecao.

- Arquitetura Leve e Segura:
  - Node.js + Express + SQLite em modo WAL de alta performance.
  - Autenticacao JWT com criptografia bcrypt para senhas.
  - Primeiro cadastro na instancia assume automaticamente o papel de Administrador (Owner).
  - Isolamento de banco de dados por instancia: o arquivo SQLite e criado do zero automaticamente.
  - Zero dependencias externas de banco (nao necessita PostgreSQL ou MySQL externos).
  - Zero credenciais hardcodadas no repositorio: configuracao estrita via `.env`.

---

## Como Rodar em Qualquer VPS

### Metodo 1: Com Docker Compose (Recomendado)

1. Clone o repositorio no servidor:
```bash
git clone https://github.com/Gumballxnz/meu-vturb.git
cd meu-vturb
```

2. Crie o arquivo de configuracao:
```bash
cp .env.example .env
```

3. Ajuste o segredo JWT no `.env`:
```bash
nano .env
# Defina um valor longo e aleatorio para JWT_SECRET
```

4. Suba o container:
```bash
docker compose up -d --build
```

O servico estara ativo em `http://IP_DO_SERVIDOR:4000`.

---

### Metodo 2: Direto com Node.js

Requisitos: Node.js 20+ e FFmpeg instalado no sistema.

1. Clone e entre na pasta:
```bash
git clone https://github.com/Gumballxnz/meu-vturb.git
cd meu-vturb/server
```

2. Instale as dependencias:
```bash
npm install --production
```

3. Configure as variaveis de ambiente:
```bash
cp ../.env.example .env
```

4. Inicie o servidor:
```bash
npm start
```

---

## Primeiro Acesso e Configuracao Inicial

1. Ao abrir o painel pela primeira vez, nenhuma conta existira no banco.
2. Clique em **Cadastre-se** e preencha seu nome, e-mail e senha.
3. Insira o codigo de confirmacao de 8 digitos:
   - Se `RESEND_API_KEY` estiver preenchida no `.env`, o codigo chegara no seu e-mail.
   - Se `RESEND_API_KEY` estiver vazia, o codigo sera exibido diretamente nos logs do terminal (`docker compose logs -f` ou console do Node).
4. Como esta e a primeira conta criada, ela recebera automaticamente o papel de **Owner (Administrador Geral)**, com acesso total a criacao de pastas, upload de videos, configuracoes de cota e aprovacao de novos membros.

---

## Variaveis de Ambiente (.env)

| Variavel | Descricao | Padrao |
|---|---|---|
| `PORT` | Porta de execucao do servidor | `4000` |
| `NODE_ENV` | Modo de execucao (`production` ou `development`) | `production` |
| `JWT_SECRET` | Chave secreta longa para assinatura de tokens JWT | *Obrigatorio em producao* |
| `BASE_DOMAIN` | Dominio base para links e embeds | *Vazio (usa hostname)* |
| `DASH_DOMAIN` | Dominio exclusivo do painel (opcional) | *Vazio* |
| `PLAYER_DOMAIN` | Dominio exclusivo do player de video (opcional) | *Vazio* |
| `RESEND_API_KEY` | Chave de API do Resend para envio de e-mails | *Opcional* |
| `RESEND_FROM_EMAIL` | Remetente autenticado do Resend | `CloudVTurb <onboarding@resend.dev>` |
| `GOOGLE_CLIENT_ID` | Client ID OAuth 2.0 do Google Cloud | *Opcional (para importacao do Drive)* |
| `GOOGLE_API_KEY` | Chave de API do Google Cloud para o Google Picker | *Opcional (para importacao do Drive)* |
| `DATA_DIR` | Diretorio do banco de dados SQLite e avatares | `/app/data` ou `./server/data` |
| `VIDEOS_DIR` | Diretorio de armazenamento de videos | `/app/videos` ou `./server/videos` |
| `HLS_CONCURRENCY` | Quantos videos o FFmpeg transcodifica ao mesmo tempo (fila) | `1` |
| `CLOUDFLARE_ZONE_ID` | ID da zona Cloudflare, para limpar o cache ao excluir/bloquear videos | *Opcional* |
| `CLOUDFLARE_API_TOKEN` | Token da Cloudflare com permissao `Zone > Cache Purge > Purge` | *Opcional* |

---

## Como Configurar a Importacao Direta do Google Drive

A plataforma possui integracao nativa com o **Google Picker API**. Com ela, o usuario clica em **Google Drive**, a janela oficial do Google abre direto no navegador, ele seleciona qualquer video de sua conta (ou de Drives Compartilhados) e o servidor baixa o arquivo via streaming de alta velocidade, processa os metadados com FFmpeg FastStart e disponibiliza o player imediatamente.

### Passo a Passo no Google Cloud Console:

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/) e crie um novo projeto (ex: `CloudVTurb`).
2. **Ativar as APIs necessarias**:
   - No menu lateral, va em **APIs e Servicos** ➡️ **Biblioteca**.
   - Pesquise por **Google Drive API** e clique em **Ativar**.
   - Pesquise por **Google Picker API** e clique em **Ativar**.
3. **Configurar a Tela de Consentimento OAuth**:
   - Va em **APIs e Servicos** ➡️ **Tela de consentimento OAuth**.
   - Escolha **Externo** e clique em **Criar**.
   - Preencha o nome do app (`CloudVTurb`) e seu e-mail de suporte.
   - Em **Escopos**, adicione o escopo `https://www.googleapis.com/auth/drive.file` (permite ler apenas os arquivos que o usuario explicitamente escolher no seletor).
   - Em **Usuarios de teste**, adicione o e-mail do Google que voce usara para testar (se o app estiver em modo de teste).
4. **Criar o ID do Cliente OAuth 2.0**:
   - Va em **APIs e Servicos** ➡️ **Credenciais** ➡️ **Criar Credenciais** ➡️ **ID do cliente OAuth**.
   - **Tipo de aplicativo**: `Aplicativo da Web`.
   - **Nome**: `CloudVTurb Web Client`.
   - **Origens JavaScript autorizadas**:
     - Para desenvolvimento local: `http://localhost:3000` e `http://localhost:4000`
     - Para producao: `https://dash.meudominio.com` e `https://meudominio.com` (sem barra no final)
   - Clique em **Criar** e copie o **ID do Cliente** (ex: `123456789-xxxx.apps.googleusercontent.com`).
5. **Criar a Chave de API (API Key)**:
   - Na mesma pagina de **Credenciais**, clique em **Criar Credenciais** ➡️ **Chave de API**.
   - Copie a chave gerada (ex: `AIzaSyD...`).
   - *(Opcional recomendado)*: Clique em **Restringir chave** e selecione apenas a **Google Picker API**.
6. **Inserir no `.env` do Servidor**:
   ```env
   GOOGLE_CLIENT_ID=123456789-xxxx.apps.googleusercontent.com
   GOOGLE_API_KEY=AIzaSyD...
   ```
7. Reinicie o servidor (`docker compose restart` ou `npm start`). O botao do Google Drive no modal de novo video estara 100% operacional.

---

## Como Configurar o Envio de E-mails via Resend

O **Resend** e utilizado para o envio transacional de e-mails:
- Codigo de 8 digitos para confirmacao de cadastro.
- Recuperacao de senha esquecida.
- Convite de novos membros de equipe pelo Administrador.
- Alertas automaticos de moderacao e seguranca.

### Comportamento em Desenvolvimento vs Producao:
- **Sem chave configurada (`RESEND_API_KEY` vazia)**: O sistema nao quebra nem trava! O codigo de 8 digitos de verificacao e exibido diretamente nos logs do console do servidor (`docker compose logs -f` ou terminal do Node.js). Isso permite testar e desenvolver localmente sem custo ou configuracao previa.
- **Com chave configurada**: Os e-mails sao disparados instantaneamente para a caixa de entrada do usuario.

### Passo a Passo de Configuracao:

1. Acesse [Resend.com](https://resend.com/) e crie uma conta gratuita.
2. No painel, acesse **API Keys** e clique em **Create API Key**.
3. De um nome (ex: `CloudVTurb Production`) e copie a chave que comeca com `re_`.
4. **Para testes rapidos (sem dominio proprio)**:
   - Voce pode usar o remetente padrao de testes da Resend:
     ```env
     RESEND_API_KEY=re_sua_chave_aqui
     RESEND_FROM_EMAIL=CloudVTurb <onboarding@resend.dev>
     ```
     *(Nota: o remetente `onboarding@resend.dev` permite enviar e-mails apenas para o mesmo e-mail titular da sua conta no Resend).*
5. **Para producao (com seu proprio dominio)**:
   - No menu **Domains** do Resend, clique em **Add Domain** (ex: `meudominio.com`).
   - Adicione os registros DNS gerados (DKIM e SPF) na Cloudflare ou no seu provedor de DNS.
   - Assim que o status mudar para **Verified**, configure no `.env`:
     ```env
     RESEND_API_KEY=re_sua_chave_aqui
     RESEND_FROM_EMAIL=CloudVTurb <nao-responda@meudominio.com>
     ```
6. Reinicie o servidor. Todos os fluxos de autenticacao e convites passarao a disparar e-mails autenticados com entregabilidade maxima.

## Otimizacao para Alta Escala e Maxima Performance (Custo R$ 0,00)

Para rodar dezenas de ofertas em escala com centenas ou milhares de pessoas assistindo simultaneamente sem gastar nada com CDNs pagas e sem sobrecarregar a largura de banda da VPS, siga estas recomendacoes essenciais:

### 1. DNS e Proxy no Cloudflare (Gratuito)

1. Aponte seus dominios para o IP da sua VPS:
   - `@` ou `meudominio.com` (Tipo `A` -> IP da VPS, Nuvem Laranja **Ativada**)
   - `player.meudominio.com` (Tipo `CNAME` ou `A` -> IP da VPS, Nuvem Laranja **Ativada**)
   - `dash.meudominio.com` (Tipo `CNAME` ou `A` -> IP da VPS, Nuvem Laranja **Ativada**)
2. O **Proxy Laranja (Proxied)** oculta o IP real do seu servidor, oferece protecao anti-DDoS e permite que a rede global da Cloudflare sirva seus arquivos diretamente dos servidores de borda (Edge) em Sao Paulo, Rio de Janeiro e outras capitais.

---

### 2. Regra de Cache para Seguranca e Escala de Videos HLS (Obrigatorio para Trafego Pesado)

Por padrao, o plano gratuito da Cloudflare nao armazena em cache arquivos de video fragmentado (`.ts`). Para habilitar o cache dos segmentos de streaming e economizar mais de 95% do consumo de banda do seu servidor:

1. No painel da **Cloudflare**, selecione seu dominio.
2. No menu lateral, acesse **Caching** ➡️ **Cache Rules** (Regras de Cache).
3. Clique em **Criar regra** (Create rule) e selecione **Cache Rules**.
4. Configure os campos exatamente assim:
   - **Nome da regra**: `Cache HLS Videos`
   - **Se as solicitacoes recebidas coincidirem**: `Personalizar expressao do filtro`
   - **Campo**: `Caminho do URI` (ou `URI Path`)
   - **Operador**: `comeca com` (ou `starts with`)
   - **Valor**: `/videos/`
   *(Ou no editor de expressao: `starts_with(http.request.uri.path, "/videos/")`)*
   - **Elegibilidade de cache**: `Qualificado para cache` (Eligible for cache)
   - **TTL da borda**: Clique em `+ Adicionar configuracao` e selecione `Use o cabecalho de controle de cache, se presente, e ignore o cache, caso contrario` (ou *Respect origin*)
5. Clique em **Implantar** (Deploy).

**Resultado**: O primeiro visitante que solicita um trecho de video faz o download da sua VPS uma unica vez. Todos os proximos milhares de visitantes baixam os pedacos diretamente do cache da Cloudflare em milissegundos, com consumo zero de banda do seu servidor.

**Como o cache se mantem correto:**
- Playlists (`.m3u8`) sao enviadas com `no-store` e nunca ficam em cache.
- Segmentos (`.ts`), posters e MP4 usam `immutable` (1 ano). Cada transcodificacao gera segmentos com um **nome novo** (`s<versao>_<qualidade>_<n>.ts`), entao reprocessar um video nunca entrega pedacos antigos do cache.
- Ao **excluir ou bloquear** um video, o servidor limpa o cache da Cloudflare automaticamente se `CLOUDFLARE_ZONE_ID` e `CLOUDFLARE_API_TOKEN` estiverem configurados. Sem eles, o video apagado pode continuar sendo servido pelo cache.
- Para conferir se esta funcionando, abra a URL de um `.ts` e veja o cabecalho `cf-cache-status` (`HIT` = servido pela Cloudflare).

---

### 3. Ajustes de Rede e Velocidade no Painel Cloudflare

Acesse o menu **Speed** (Velocidade) e **Network** (Rede) no Cloudflare e garanta que as seguintes opcoes gratuitas estejam ativadas:
- **HTTP/2** e **HTTP/3 (com QUIC)**: Entrega paralela de pacotes de dados, essencial para o buffer instantaneo do player.
- **Brotli**: Compressao superior para scripts HTML/JS/CSS.
- **0-RTT Connection Resumption**: Acelera o handshake TLS em conexoes recorrentes de visitantes mobile.
- **Early Hints**: Antecipa o carregamento de scripts criticos do player.

---

### 4. Ajustes do Servidor Linux/VPS (Para Milhares de Conexoes Concorrentes)

Se estiver rodando em Linux direto ou Docker, certifique-se de que o limite de descritores de arquivos abertos suporta conexoes concorrentes macicas:

```bash
# Verificar limite atual
ulimit -n

# Aumentar temporariamente para a sessao atual
ulimit -n 65535
```

Para tornar permanente, adicione ao final de `/etc/security/limits.conf`:
```ini
* soft nofile 65535
* hard nofile 65535
```

Se utilizar **Nginx** como Proxy Reverso na frente do Node.js:
```nginx
# Permitir uploads grandes de video
client_max_body_size 2048M;

# Manter timeouts adequados para processamento de video
proxy_connect_timeout 300s;
proxy_send_timeout 300s;
proxy_read_timeout 300s;

# Desativar bufferizacao de proxy para streaming continuo
location /videos/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
}
```
