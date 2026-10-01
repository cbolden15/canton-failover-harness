#!/usr/bin/env node
import { requireSupportedNode } from '../scripts/runtime.mjs';

requireSupportedNode();
await import('../dist/cli.js');
