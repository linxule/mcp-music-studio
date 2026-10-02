# MCP Music Studio

[English](https://github.com/linxule/mcp-music-studio/blob/main/README.md) · [简体中文](https://github.com/linxule/mcp-music-studio/blob/main/README.zh-CN.md) · **Français** · [日本語](https://github.com/linxule/mcp-music-studio/blob/main/README.ja.md)

[![npm](https://img.shields.io/npm/v/mcp-music-studio)](https://www.npmjs.com/package/mcp-music-studio) [![CI](https://github.com/linxule/mcp-music-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/linxule/mcp-music-studio/actions/workflows/ci.yml) [![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://github.com/linxule/mcp-music-studio/blob/main/LICENSE)

Créez de la musique avec un assistant IA, directement dans le chat. Demandez un morceau pour obtenir une partition à jouer et modifier. Demandez un rythme pour ouvrir un lecteur de live coding avec des visuels. Modifiez ensuite le morceau ensemble, ajustez ses réglages pendant la lecture ou jouez à tour de rôle avec l'IA.

Music Studio est un serveur MCP. MCP est un protocole standard permettant d'ajouter des outils à un assistant IA ; vous avez besoin d'une application de chat compatible, comme Claude. Dans Claude, claude.ai et les autres applications prenant en charge MCP Apps, le lecteur s'affiche dans le chat. Dans Claude Code et les applications en terminal, vous obtenez un lien qui ouvre le lecteur dans votre navigateur.

<a href="https://github.com/linxule/mcp-music-studio/releases/download/v0.5.3/mcp-music-studio-v0.5-live-set-1080p60.mp4"><img src="https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/live-set-stage.gif" alt="Un motif Strudel avec son piano roll injecté dans un shader Hydra, puis le mode Stage occupant tout le cadre" width="720"></a>

*Un set en direct dans le lecteur. Chaque section correspond à une modification apportée pendant que la musique tourne. [Voir la vidéo complète](https://github.com/linxule/mcp-music-studio/releases/download/v0.5.3/mcp-music-studio-v0.5-live-set-1080p60.mp4).*

## Démarrage rapide

Ajoutez cette URL comme serveur MCP distant. Il n'y a rien à installer.

```
https://music-studio.linxule.com/mcp
```

- **Claude et claude.ai :** ouvrez Paramètres, puis Connecteurs, ajoutez un connecteur personnalisé et collez l'URL.
- **Claude Code :** lancez `claude mcp add --transport http music-studio https://music-studio.linxule.com/mcp`

Demandez ensuite une chanson, un rythme ou un clip musical. Aucun compte n'est requis. Votre navigateur peut bloquer le son jusqu'à ce que vous cliquiez une première fois sur Play dans le lecteur.

## Ce que vous pouvez créer

- **Partitions.** Des partitions en notation ABC, affichées sous forme de partition et jouées avec l'un des 128 instruments General MIDI. Choisissez un style (rock, jazz, bossa, entre autres) pour ajouter batterie, basse et accords. Modifiez la partition sur place, transposez-la et téléchargez le fichier WAV ou MIDI. [En savoir plus sur les partitions](https://github.com/linxule/mcp-music-studio/blob/main/docs/sheet-music.md) (en anglais)
- **Live coding.** Des motifs dans [Strudel](https://strudel.cc), la version JavaScript de TidalCycles, dans un éditeur modifiable pendant la lecture : boîtes à rythmes, synthés, effets, piano rolls et visuels de shaders Hydra calés sur le son. [En savoir plus sur le live coding](https://github.com/linxule/mcp-music-studio/blob/main/docs/live-coding.md) (en anglais)
- **Clips et pièces scéniques.** Le code peut dessiner, réagir à chaque note, répondre au toucher et prononcer des répliques en mesure avec la musique. La galerie du guide propose un court-métrage, un duo parlé et un Jeu de la vie qui compose.
- **Jouer ensemble.** Une session en direct garde un lecteur unique ouvert. L'IA lit ce que vous avez fait et place sa réponse dans le même lecteur, au début de la mesure suivante. Faders, pads et mouvements de votre téléphone deviennent des contrôleurs. [Jouer ensemble : en savoir plus](https://github.com/linxule/mcp-music-studio/blob/main/docs/playing-together.md) (en anglais)
- **Partage.** Quand une partition ou un motif est assez petit pour tenir dans un lien, la réponse inclut un lien ouvrant le lecteur complet. Pour un morceau plus volumineux, demandez un lien stocké, valable 30 jours.

## Outils

| Outil | Description |
|------|--------------|
| `play-sheet-music` | Affiche et joue une partition écrite en notation ABC |
| `play-live-pattern` | Ouvre un lecteur de live coding pour du code Strudel, avec session en direct optionnelle |
| `get-session` | Lit les événements d'une session en direct, ou attend que l'auditeur appuie sur Pass |
| `update-session` | Remplace le code dans le lecteur d'une session à la mesure ou phrase suivante |
| `get-music-guide` | Guide de référence pour la notation ABC : syntaxe, instruments, styles, genres |
| `get-strudel-guide` | Guide de référence pour Strudel : sons, effets, visuels, Stage, pièces de la galerie |
| `search-music-docs` | Recherche dans la documentation de Strudel et abcjs |
| `analyze-harmony` | Identifie les accords, détecte la tonalité, construit des progressions |
| `convert-abc-to-strudel` | Convertit une mélodie notée en motif Strudel |
| `create-share-link` | Enregistre un morceau pendant 30 jours et renvoie un lien accessible à tous |

Paramètres, prompts et outils intégrés aux lecteurs : [outils et prompts](https://github.com/linxule/mcp-music-studio/blob/main/docs/tools.md) (en anglais).

## Lancer le serveur en local

L'URL hébergée ne demande aucune configuration. Pour exécuter le serveur en local, utilisez npm :

```bash
claude mcp add music-studio -- npx -y mcp-music-studio --stdio
```

Configuration pour Claude Desktop, Codex, Gemini CLI, VS Code, Cursor, Windsurf et autres environnements, modes de rendu et mode HTTP : [installation et configuration client](https://github.com/linxule/mcp-music-studio/blob/main/docs/install.md) (en anglais).

## En savoir plus

- [Journal des modifications](https://github.com/linxule/mcp-music-studio/blob/main/CHANGELOG.md) (en anglais)
- [Développement](https://github.com/linxule/mcp-music-studio/blob/main/docs/development.md) (en anglais)
- [Politique de confidentialité](https://music-studio.linxule.com/privacy). La lecture simple n'enregistre pas votre morceau dans la base de partage. Une session en direct conserve son historique pendant deux heures après la dernière activité, et les répliques parlées restent en cache 30 jours. Les liens qui intègrent la musique dans l'URL la transportent directement dans celle-ci. Ne mettez aucune information privée dans les partitions, le code, les titres ou les répliques parlées. `create-share-link` ne stocke une création que si vous le demandez.
- [Signaler un problème](https://github.com/linxule/mcp-music-studio/issues)

## Crédits et licence

Issu d'un fork de l'exemple [Sheet Music Server](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/sheet-music-server) de [MCP ext-apps](https://github.com/modelcontextprotocol/ext-apps) par Anthropic (MIT). Le live coding repose sur [Strudel](https://codeberg.org/uzu/strudel), la notation sur [abcjs](https://github.com/paulrosen/abcjs) et les visuels de shaders sur [hydra-synth](https://hydra.ojack.xyz).

Sous licence AGPL-3.0-or-later. Les mentions MIT d'origine se trouvent dans [LICENSES/MIT.txt](https://github.com/linxule/mcp-music-studio/blob/main/LICENSES/MIT.txt). Consultez [SOURCE.md](https://github.com/linxule/mcp-music-studio/blob/main/SOURCE.md) pour le code source correspondant et [THIRD_PARTY_NOTICES.md](https://github.com/linxule/mcp-music-studio/blob/main/THIRD_PARTY_NOTICES.md) pour les licences des dépendances et des éléments audio. La musique que vous créez n'est pas automatiquement soumise à la licence du logiciel.
