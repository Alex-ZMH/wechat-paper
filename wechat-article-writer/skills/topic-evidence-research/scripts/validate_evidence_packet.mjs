#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import process from 'node:process';
import { validateEvidencePacket } from './evidence_packet_validator.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node validate_evidence_packet.mjs <packet.json>');
  process.exitCode = 2;
} else {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    validateEvidencePacket(value, { requireAudit: true, requirePacketHash: false });
    console.log('valid content-desk.evidence-packet.v1');
  } catch (error) {
    console.error(error?.message ?? 'invalid packet');
    process.exitCode = 1;
  }
}
