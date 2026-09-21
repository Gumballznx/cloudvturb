#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' || args[i] === '-p') {
    process.env.PORT = args[i + 1];
    i++;
  } else if (args[i] === '--data' || args[i] === '-d') {
    process.env.DATA_DIR = path.resolve(args[i + 1]);
    i++;
  } else if (args[i] === '--videos' || args[i] === '-v') {
    process.env.VIDEOS_DIR = path.resolve(args[i + 1]);
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
CloudVTurb - High-Conversion VSL Hosting & Streaming Platform

Uso:
  npx cloudvturb [opções]

Opções:
  -p, --port <porta>    Porta do servidor (Padrão: 4000)
  -d, --data <dir>      Diretório do banco SQLite (Padrão: ./data)
  -v, --videos <dir>    Diretório de vídeos (Padrão: ./videos)
  -h, --help            Exibe esta ajuda
`);
    process.exit(0);
  }
}

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = path.join(process.cwd(), 'data');
}
if (!process.env.VIDEOS_DIR) {
  process.env.VIDEOS_DIR = path.join(process.cwd(), 'videos');
}

require(path.join(__dirname, '..', 'server', 'server.js'));
