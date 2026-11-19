// Change notices for GET /v1/events: after a write commits, every listener in
// that property who may view the table hears which table and rows changed,
// and refetches what shows it. In-process: one API process for now (HANDOVER
// §16 #1). Several processes would need Postgres LISTEN/NOTIFY behind this
// same interface.

import type { Id } from '@stitchflow/contract';
import type { ServerResponse } from 'node:http';

export interface ChangeNotice {
  table: string;
  ids: Id[];
}

type Listener = (n: ChangeNotice) => void;

/** Who is listening: the member, and the tables they may view at connect time. */
export interface Audience {
  memberId: Id;
  tables: Set<string>;
}

export class EventBus {
  #listeners = new Map<Id, Map<Listener, Audience>>();
  #streams = new Map<Id, Set<ServerResponse>>();

  /** Registers an open event stream for a member; returns the untrack. */
  track(res: ServerResponse, memberId: Id = ''): () => void {
    let set = this.#streams.get(memberId);
    if (!set) this.#streams.set(memberId, (set = new Set()));
    set.add(res);
    return () => {
      set.delete(res);
      if (!set.size) this.#streams.delete(memberId);
    };
  }

  static #end(res: ServerResponse): void {
    try {
      res.write('event: bye\ndata: {}\n\n');
      res.end();
    } catch {
      // already gone
    }
  }

  /** Ends one member's streams, for when their access changes or ends. */
  drop(memberId: Id): void {
    for (const res of this.#streams.get(memberId) ?? []) EventBus.#end(res);
    this.#streams.delete(memberId);
  }

  /** Clean shutdown: tell every open stream, then end it. */
  endStreams(): void {
    for (const set of this.#streams.values()) for (const res of set) EventBus.#end(res);
    this.#streams.clear();
  }

  emit(propertyId: Id, notice: ChangeNotice): void {
    for (const [l, a] of this.#listeners.get(propertyId) ?? []) if (a.tables.has(notice.table)) l(notice);
  }

  /** Returns the unsubscribe. */
  listen(propertyId: Id, audience: Audience, l: Listener): () => void {
    let map = this.#listeners.get(propertyId);
    if (!map) this.#listeners.set(propertyId, (map = new Map()));
    map.set(l, audience);
    return () => {
      map.delete(l);
      if (!map.size) this.#listeners.delete(propertyId);
    };
  }
}
