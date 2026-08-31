// The one workspaceState-backed settings store.
//
// Four feature stores had byte-identical `getState`/`save` bodies differing
// only in their key and defaults (AskAi, DebugLogs, and the settings half of
// Query and RestCall). That shape is here now; a feature supplies only what is
// actually its own.
//
// `MementoLike` rather than `vscode.Memento` keeps this vscode-free, so every
// consumer stays unit-testable against a plain object — which is how the
// existing store tests already work, so adopting this was a one-line change per
// call site in each of them.

export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/**
 * A single JSON blob under one key, merged over defaults on read.
 *
 * The merge is deliberately shallow and defaults-first: a key added to the
 * state shape in a later release is absent from what an existing workspace has
 * stored, and picks up its default instead of coming back `undefined`.
 */
export class MementoStore<T extends object> {
  constructor(
    private readonly memento: MementoLike,
    private readonly key: string,
    private readonly defaults: T,
  ) {}

  getState(): T {
    const stored = this.memento.get<Partial<T>>(this.key, {} as Partial<T>);
    return { ...this.defaults, ...stored };
  }

  async save(patch: Partial<T>): Promise<T> {
    const next = { ...this.getState(), ...patch };
    await this.memento.update(this.key, next);
    return next;
  }
}
