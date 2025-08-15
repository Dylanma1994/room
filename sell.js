#!/usr/bin/env node

const SellCommand = require('./src/sellCommand');

const sellCommand = new SellCommand();
const [,, command, ...args] = process.argv;

sellCommand.run(command || 'help', ...args);
