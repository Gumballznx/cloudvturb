# CloudVTurb — Design System Congelado

Este documento é a fonte de verdade visual do CloudVTurb. Toda alteração de interface deve respeitá-lo. Não criar cores, gradientes, botões ou estilos locais fora destes tokens sem aprovação explícita do proprietário do projeto.

## Direção visual

Produto SaaS limpo, confiável e leve, com base branca, azul como cor de ação e texto escuro. A identidade não usa violeta. Evitar aparência pesada, decorativa ou excessivamente "gamer".

## Paleta oficial

| Token | Valor | Uso |
| --- | --- | --- |
| `--color-primary` | `#2563EB` | ação principal, links, navegação ativa e foco |
| `--color-primary-hover` | `#1D4ED8` | hover e estado pressionado |
| `--color-primary-soft` | `#EFF6FF` | fundos selecionados e informações leves |
| `--color-primary-border` | `#BFDBFE` | bordas de elementos azuis leves |
| `--color-page` | `#F8FAFC` | fundo geral do dashboard |
| `--color-surface` | `#FFFFFF` | sidebar, cards, menus e modais |
| `--color-surface-muted` | `#F1F5F9` | áreas secundárias e hover neutro |
| `--color-border` | `#E2E8F0` | bordas padrão |
| `--color-text` | `#0F172A` | títulos e texto principal |
| `--color-text-muted` | `#64748B` | texto auxiliar |
| `--color-success` | `#16A34A` | sucesso e espaço disponível |
| `--color-warning` | `#D97706` | alerta real |
| `--color-danger` | `#DC2626` | exclusão, bloqueio e ações destrutivas |
| `--color-video-bg` | `#000000` | fundo exclusivo do player de vídeo |

Não usar violeta (`#7C3AED`, `#8B5CF6` ou similares) em novos componentes ou no logo.

## Logo e favicon

- Criar marca original em SVG: ícone azul de play/streaming e palavra `CloudVTurb` em `--color-text`.
- Em superfícies escuras, usar versão com texto branco e ícone azul.
- Favicon: somente ícone azul, sem letras pequenas ou detalhes ilegíveis.
- Não usar logos, formas ou identidade visual de concorrentes.

## Componentes

### Botões

- Primário: fundo `--color-primary`, texto branco; hover `--color-primary-hover`.
- Secundário: fundo branco, borda `--color-border`, texto `--color-text`.
- Perigo: usar apenas em exclusão/bloqueio confirmados; borda ou fundo `--color-danger`.
- Todos devem ter a mesma altura por contexto, borda de 8px, foco visível e estado de carregamento.
- Ações assíncronas: desabilitar após o primeiro clique, mostrar spinner azul ou branco adequado e restaurar o botão em caso de erro.

### Cards, menus e inputs

- Fundo `--color-surface`, borda `--color-border`, raio de 12px.
- Sombras discretas; não usar sombras coloridas.
- Estado ativo/selecionado: `--color-primary-soft`, texto azul e borda azul clara.
- Inputs com foco azul, sem contornos de outras cores.

### Player e Smart Autoplay

- Vídeo permanece com fundo preto.
- O aviso de ativação de áudio usa obrigatoriamente este padrão inicial: cartão azul `#2563EB`, formato quadrado, cantos discretamente arredondados (8px), texto e ícone brancos.
- Copy padrão exata, em duas linhas/blocos: `Seu vídeo ja iniciou` e `Clique para escutar`.
- O ícone central deve ser um SVG branco de áudio silenciado, grande e legível.
- O cartão começa centralizado sobre o vídeo, sem formato de cápsula, sem círculo e sem halo violeta.
- Cada VSL poderá personalizar o botão posteriormente, mas o editor deve iniciar sempre com esse padrão azul quadrado. Não vincular a cor do botão à barra de progresso.

## Layout responsivo

- Desktop: sidebar de 260px, conteúdo com largura fluida e espaçamento de 24px.
- Tablet: preservar hierarchy, reduzir grades para duas colunas quando necessário.
- Mobile: sidebar vira menu lateral com backdrop; conteúdo em uma coluna; botões primários ocupam largura total em formulários; tabelas devem ter alternativa em cards ou rolagem horizontal controlada.
- Alvos de toque mínimos de 44px.
- Não esconder ações essenciais no mobile.

## Regras de conteúdo e dados

- Sem emojis na interface.
- Sem métricas, notificações, banners, contadores, integrações ou estados falsos.
- Estados vazios devem explicar o próximo passo e usar ícone SVG simples.
- Todas as permissões, cotas e métricas devem vir do backend.

## Processo obrigatório

Antes de criar ou alterar telas, reutilize os tokens e componentes existentes. Se uma nova cor ou padrão for realmente necessário, atualize este documento primeiro e aguarde aprovação do proprietário.
