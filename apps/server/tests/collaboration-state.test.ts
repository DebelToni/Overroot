import { seedUser } from './helpers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { CollaborationManager, EventHub } from '../src/collaboration.js';
import { Database } from '../src/database.js';
import { ProjectStore } from '../src/project-store.js';

 describe('persistent Yjs state', () => {
  it('keeps causal identities across a backend restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'overroot-y-state-'));
    const path = join(dir, 'state.sqlite3');
    try {
      const firstDb = new Database(path);
      const owner = seedUser(firstDb, 'owner', true);
      const firstStore = new ProjectStore(firstDb);
      const project = firstStore.createProject(owner.id, 'Persistent paper');
      const file = firstStore.getFile(project.id, 'main.tex')!;
      const offlineClient = new Y.Doc();
      Y.applyUpdate(offlineClient, file.y_state!);

      const firstCollaboration = new CollaborationManager(firstStore, new EventHub());
      await firstCollaboration.replaceText(file.id, '\\documentclass{article}\n\\begin{document}Restart safe\\end{document}\n', {
        type: 'agent', id: 'agent', name: 'Agent'
      });
      await firstCollaboration.close();
      firstDb.close();

      const secondDb = new Database(path);
      const secondStore = new ProjectStore(secondDb);
      const restarted = secondStore.getFileById(file.id)!;
      const serverAfterRestart = new Y.Doc();
      Y.applyUpdate(serverAfterRestart, restarted.y_state!);

      Y.applyUpdate(
        offlineClient,
        Y.encodeStateAsUpdate(serverAfterRestart, Y.encodeStateVector(offlineClient))
      );
      Y.applyUpdate(
        serverAfterRestart,
        Y.encodeStateAsUpdate(offlineClient, Y.encodeStateVector(serverAfterRestart))
      );

      expect(offlineClient.getText('content').toString()).toContain('Restart safe');
      expect(offlineClient.getText('content').toString()).not.toMatch(/\\documentclass[\s\S]*\\documentclass/);
      expect(serverAfterRestart.getText('content').toString()).toBe(offlineClient.getText('content').toString());
      offlineClient.destroy();
      serverAfterRestart.destroy();
      secondDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
