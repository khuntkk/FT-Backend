// Change notices for GET /v1/events: after a write commits, every listener in
// that property hears which table and rows changed, and refetches what shows
// it. In-process: one API process for now (HANDOVER §16 #1). Several
// processes would need Postgres LISTEN/NOTIFY behind this same interface.

export interface ChangeNotice {
  table: string;
  ids: number[];
}

type Listener = (n: ChangeNotice) => void;

export class EventBus {
  #listeners = new Map<number, Set<Listener>>();

  emit(propertyId: number, notice: ChangeNotice): void {
    for (const l of this.#listeners.get(propertyId) ?? []) l(notice);
  }

  /** Returns the unsubscribe. */
  listen(propertyId: number, l: Listener): () => void {
    let set = this.#listeners.get(propertyId);
    if (!set) this.#listeners.set(propertyId, (set = new Set()));
    set.add(l);
    return () => {
      set.delete(l);
      if (!set.size) this.#listeners.delete(propertyId);
    };
  }
}
