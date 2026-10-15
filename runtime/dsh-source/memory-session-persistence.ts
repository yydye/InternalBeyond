/** Process-only Session storage for the InternalBeyond ACP runtime. */

import type { Context } from '@deepseek-ai/cordis'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  assertContiguous,
  materializeAppendBatch,
  materializeCreateHeader,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleReadOptions,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetValue,
} from '@deepseek-ai/dsh-session'

interface StoredSession {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffsetValue
  events: SessionEvent[]
  revision: number
  writerOpen: boolean
}

/** Keep ACP's persistence service in memory so process exit discards the transcript. */
export default class MemorySessionPersistence extends SessionPersistence {
  private readonly records = new Map<SessionId, StoredSession>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.on('session/event', (session: Session, event) => {
      const stored = this.records.get(session.id)
      if (stored === undefined || !stored.writerOpen) return
      this.appendLive(stored, event)
    })
    ctx.on('session/flush', (session: Session) => {
      const stored = this.records.get(session.id)
      if (stored?.writerOpen !== true) return
      return Promise.resolve()
    })
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    if (this.records.has(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
    const stored: StoredSession = {
      header: snapshot,
      inheritedEventCount: SessionLogOffset(options?.inheritedEventCount ?? 0),
      events: [],
      revision: 0,
      writerOpen: true,
    }
    this.records.set(snapshot.id, stored)
    return this.handle(stored, 'write')
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const stored = this.records.get(id)
    if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
    if (access === 'write' && stored.writerOpen) throw new SessionAlreadyOwnedError(id)
    if (access === 'write') stored.writerOpen = true
    return this.handle(stored, access)
  }

  async flush(): Promise<void> {}

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    const stored = this.records.get(id)
    return stored === undefined ? undefined : this.snapshot(stored)
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted()
    return [...this.records.values()].map(stored => this.snapshot(stored))
  }

  private snapshot(stored: StoredSession): SessionPersistenceSnapshot {
    return {
      header: structuredClone(stored.header),
      revision: SessionPersistenceRevision(`memory:${stored.header.id}:${stored.revision}`),
      eventCount: stored.events.length,
    }
  }

  private appendLive(stored: StoredSession, event: SessionEvent): void {
    const batch = materializeAppendBatch([event])
    assertContiguous(stored.header.id, batch, stored.events.length)
    stored.events.push(...batch)
    stored.revision += batch.length
  }

  private handle(stored: StoredSession, access: SessionAccess): SessionHandle {
    let closed = false
    const assertOpen = (operation: string): void => {
      if (closed) throw new SessionHandleClosedError(stored.header.id, operation)
    }
    const handle: SessionHandle = {
      id: stored.header.id,
      header: stored.header,
      inheritedEventCount: stored.inheritedEventCount,
      access,
      async read(offset: number = 0, length?: number, options?: SessionHandleReadOptions) {
        assertOpen('read')
        options?.signal?.throwIfAborted()
        const end = length === undefined ? undefined : offset + length
        return {
          eventState: 'detached',
          events: structuredClone(stored.events.slice(offset, end)),
        }
      },
      async append(events, options) {
        assertOpen('append')
        if (access !== 'write') throw new SessionReadOnlyError(stored.header.id, 'append')
        options?.signal?.throwIfAborted()
        const batch = materializeAppendBatch(events)
        assertContiguous(stored.header.id, batch, stored.events.length)
        stored.events.push(...batch)
        stored.revision += batch.length
      },
      async flush(options) {
        assertOpen('flush')
        if (access !== 'write') throw new SessionReadOnlyError(stored.header.id, 'flush')
        options?.signal?.throwIfAborted()
      },
      async close() {
        if (closed) return
        closed = true
        if (access === 'write') stored.writerOpen = false
      },
      [Symbol.asyncDispose]() { return this.close() },
    }
    return handle
  }
}
