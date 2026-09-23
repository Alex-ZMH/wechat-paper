import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ContractError, freezeContract } from './primitives.mjs';
import { BRIEF_SCHEMA_VERSION } from '../contracts/brief.mjs';
import { EVIDENCE_PACKET_SCHEMA_VERSION } from '../contracts/evidence-packet.mjs';
import { RESEARCH_SESSION_SCHEMA_VERSION } from '../contracts/research-session.mjs';
import { ARGUMENT_MAP_SCHEMA_VERSION } from '../contracts/argument-map.mjs';

/**
 * Small local JSON-backed store. The contracts remain unchanged; persistence
 * only keeps the accepted research boundary available after a service restart.
 */
export class ResearchSessionStore {
  #records = new Map();
  #filePath;

  constructor({ filePath = null } = {}) {
    this.#filePath = filePath;
    this.#load();
  }

  #load() {
    if (!this.#filePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.#filePath, 'utf8'));
      const records = Array.isArray(parsed?.records) ? parsed.records : [];
      for (const record of records) {
        if (!record?.researchSession || !record?.brief || !record?.evidencePacket) continue;
        if (record.researchSession.schemaVersion !== RESEARCH_SESSION_SCHEMA_VERSION) continue;
        if (record.brief.schemaVersion !== BRIEF_SCHEMA_VERSION) continue;
        if (record.evidencePacket.schemaVersion !== EVIDENCE_PACKET_SCHEMA_VERSION) continue;
        if (record.researchSession.briefId !== record.brief.briefId) continue;
        if (record.researchSession.evidencePacketId !== record.evidencePacket.packetId) continue;
        if (record.evidencePacket.briefId !== record.brief.briefId) continue;
        if (record.argumentMap && (
          record.argumentMap.schemaVersion !== ARGUMENT_MAP_SCHEMA_VERSION ||
          record.argumentMap.briefId !== record.brief.briefId ||
          record.argumentMap.packetId !== record.evidencePacket.packetId
        )) continue;
        this.#records.set(record.researchSession.sessionId, freezeContract(record));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A corrupt local cache must not prevent the workbench from starting.
        // It is ignored and replaced by the next successful save.
        console.error(`Research session cache could not be loaded: ${error.message}`);
      }
    }
  }

  #persist() {
    if (!this.#filePath) return;
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      const temporary = join(dirname(this.#filePath), `.${Date.now()}.tmp`);
      writeFileSync(temporary, JSON.stringify({ version: 1, records: [...this.#records.values()] }, null, 2), 'utf8');
      renameSync(temporary, this.#filePath);
    } catch (error) {
      throw new ContractError('persistence_failed', `Research session could not be saved locally: ${error.message}`);
    }
  }

  save({ researchSession, brief, evidencePacket, argumentMap = null } = {}) {
    if (researchSession?.schemaVersion !== RESEARCH_SESSION_SCHEMA_VERSION) {
      throw new ContractError('schema_mismatch', 'Expected a ResearchSession contract');
    }
    if (brief?.schemaVersion !== BRIEF_SCHEMA_VERSION || evidencePacket?.schemaVersion !== EVIDENCE_PACKET_SCHEMA_VERSION) {
      throw new ContractError('schema_mismatch', 'Research session record requires a Brief and EvidencePacket');
    }
    if (
      researchSession.briefId !== brief.briefId ||
      researchSession.evidencePacketId !== evidencePacket.packetId ||
      evidencePacket.briefId !== brief.briefId
    ) {
      throw new ContractError('lineage_mismatch', 'Research session record contains mismatched artifacts');
    }
    if (argumentMap && (
      argumentMap.schemaVersion !== ARGUMENT_MAP_SCHEMA_VERSION ||
      argumentMap.briefId !== brief.briefId ||
      argumentMap.packetId !== evidencePacket.packetId
    )) {
      throw new ContractError('lineage_mismatch', 'Argument map does not belong to this research session');
    }
    const previous = this.#records.get(researchSession.sessionId) ?? null;
    const record = freezeContract({ ...(previous ?? {}), researchSession, brief, evidencePacket, ...(argumentMap ? { argumentMap } : {}) });
    this.#records.set(researchSession.sessionId, record);
    try {
      this.#persist();
    } catch (error) {
      if (previous) this.#records.set(researchSession.sessionId, previous);
      else this.#records.delete(researchSession.sessionId);
      throw error;
    }
    return record;
  }

  get(sessionId) {
    return this.#records.get(sessionId) ?? null;
  }

  saveArgumentMap(sessionId, argumentMap) {
    const existing = this.#records.get(String(sessionId ?? ''));
    if (!existing) throw new ContractError('research_session_not_found', 'Research session was not found', { sessionId });
    if (!argumentMap || argumentMap.schemaVersion !== ARGUMENT_MAP_SCHEMA_VERSION) {
      throw new ContractError('schema_mismatch', 'Expected an ArgumentMap contract');
    }
    if (argumentMap.briefId !== existing.brief.briefId || argumentMap.packetId !== existing.evidencePacket.packetId) {
      throw new ContractError('lineage_mismatch', 'Argument map does not belong to this research session');
    }
    const record = freezeContract({ ...existing, argumentMap });
    this.#records.set(existing.researchSession.sessionId, record);
    try {
      this.#persist();
    } catch (error) {
      this.#records.set(existing.researchSession.sessionId, existing);
      throw error;
    }
    return record;
  }

  list() {
    return [...this.#records.values()].map(({ researchSession }) => researchSession);
  }
}
